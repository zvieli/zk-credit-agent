import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, decodeAbiParameters, encodeFunctionData, getAddress, http, keccak256, numberToHex, parseAbiItem, parseEther } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getAxiomV2QueryAddress } from '@axiom-crypto/client';
import { initBackendEnv, readFrontendDeploymentConfig } from './env.ts';
import { generateLoanProof } from './axiom_service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

initBackendEnv();

type Hex = `0x${string}`;

const POLL_INTERVAL_MS = 1000;
const AXIOM_QUERY_INITIATED_EVENT = parseAbiItem('event QueryInitiatedOnchain(address indexed caller, bytes32 indexed queryHash, uint256 indexed queryId, bytes32 userSalt, address refundee, address target, bytes extraData)');

type AxiomRelayerConfig = {
  rpcUrl?: string | undefined;
  chainId?: number | undefined;
  axiomV2QueryAddress?: string | undefined;
  callbackTarget: string;
  creditVerifier: string;
  caller: string;
  sourceChainId?: number | undefined;
  querySchema?: Hex | undefined;
  extraData?: Hex | undefined;
  results?: Hex[] | undefined;
  startBlock?: bigint | undefined;
  pollingIntervalMs?: number | undefined;
  signerPrivateKey?: Hex | undefined;
};

const axiomCallbackAbi = [
  {
    type: 'function',
    name: 'axiomV2Callback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sourceChainId', type: 'uint64' },
      { name: 'caller', type: 'address' },
      { name: 'querySchema', type: 'bytes32' },
      { name: 'results', type: 'bytes32[]' },
      { name: 'extraData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

const axiomRelayerAbi = [
  {
    type: 'function',
    name: 'verifiedRoots',
    stateMutability: 'view',
    inputs: [{ name: 'blockNumber', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'debugSetRoot',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'b', type: 'uint256' },
      { name: 'r', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

const creditVerifierAbi = [
  {
    name: 'verifyAndRegisterScore',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'proof', type: 'bytes' },
      { name: 'commitment', type: 'bytes32' },
      { name: 'score', type: 'uint32' },
      { name: 'isSolvent', type: 'bool' },
      { name: 'proofHash', type: 'bytes32' },
      { name: 'nonce', type: 'uint32' },
      { name: 'user', type: 'address' },
      { name: 'stateRoot', type: 'bytes32' },
      { name: 'blockNumber', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

function resolveRpcUrl() {
  return process.env.ANVIL_RPC_URL || process.env.RPC_URL || process.env.PROOF_RPC_URL || 'http://127.0.0.1:8545';
}

function resolveAgentPrivateKey() {
  const privateKey = process.env.AGENT_PRIVATE_KEY || process.env.AXIOM_QUERY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('Missing AGENT_PRIVATE_KEY.');
  }

  return privateKey as Hex;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startAxiomRelayer(config: Partial<AxiomRelayerConfig> = {}) {
  const deployment = readFrontendDeploymentConfig();
  const rpcUrl = config.rpcUrl || resolveRpcUrl();
  const chainId = mainnet.id;
  const publicClient = createPublicClient({
    chain: {
      ...mainnet,
      id: 31337,
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    },
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  const account = privateKeyToAccount(resolveAgentPrivateKey());
  const walletClient = createWalletClient({
    account,
    chain: {
      ...mainnet,
      id: 31337,
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    },
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  const callbackTargetRaw = config.callbackTarget || process.env.AXIOM_V3_RELAYER_ADDRESS || deployment.creditPolicyAddress;
  if (!callbackTargetRaw) {
    throw new Error('Missing AXIOM_V3_RELAYER_ADDRESS or CREDIT_POLICY_ADDRESS.');
  }

  const creditVerifierRaw = config.creditVerifier || process.env.CREDIT_VERIFIER_ADDRESS || deployment.creditVerifierAddress;
  if (!creditVerifierRaw) {
    throw new Error('Missing CREDIT_VERIFIER_ADDRESS.');
  }

  const callbackTarget = getAddress(callbackTargetRaw);
  const creditVerifier = getAddress(creditVerifierRaw);
  const caller = getAddress(config.caller || process.env.AXIOM_CALLBACK_CALLER || callbackTarget);
  const sourceChainId = BigInt(chainId);
  const querySchema = config.querySchema || (process.env.AXIOM_QUERY_SCHEMA as Hex | undefined) || ('0x' + '00'.repeat(32)) as Hex;
  const axiomV2QueryAddress = getAddress(config.axiomV2QueryAddress || process.env.AXIOM_V2_QUERY_ADDRESS || deployment.axiomV2QueryAddress || getAxiomV2QueryAddress(String(chainId)));
  let lastScannedBlock: bigint = config.startBlock ?? 0n;
  const processedLogs = new Set<string>();
  let stopped = false;

  async function pollOnce(): Promise<bigint> {
    const latestBlock: bigint = (await publicClient.getBlockNumber()) ?? 0n;
    const scanStart = lastScannedBlock > 0n ? lastScannedBlock - 1n : 0n;

    console.log(`[relayer] Scanning for queries between blocks ${scanStart.toString()} and ${latestBlock.toString()}...`);

    for (let chunkStart = scanStart; chunkStart <= latestBlock; chunkStart += 10n) {
      const chunkEnd = chunkStart + 9n < latestBlock ? chunkStart + 9n : latestBlock;

      const logs = await publicClient.getLogs({
        address: axiomV2QueryAddress,
        event: AXIOM_QUERY_INITIATED_EVENT,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      for (const log of logs) {
        const logKey = `${log.transactionHash ?? '0x'}:${log.logIndex ?? 0n}`;
        if (processedLogs.has(logKey)) {
          continue;
        }

        const { queryId, extraData } = log.args;
        if (queryId === undefined || extraData === undefined) {
          continue;
        }

        let userAddress: Hex;
        let targetBlock: bigint;
        try {
          [userAddress, targetBlock] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], extraData);
        } catch {
          // Fallback for old extraData format if needed
          try {
            [targetBlock] = decodeAbiParameters([{ type: 'uint256' }], extraData);
            userAddress = account.address; // Should not happen in new flow
          } catch {
            continue;
          }
        }

        const block = await publicClient.getBlock({ blockNumber: targetBlock });
        const realRoot = block.stateRoot as Hex;

        console.log(`[relayer] Found query for block ${targetBlock.toString()}. Relaying root ${realRoot} via debugSetRoot to ${callbackTarget}....`);

        // DIRECT CALL: Bypassing impersonation and using Agent's funded wallet
        const txHash = await walletClient.writeContract({
            address: callbackTarget,
            abi: axiomRelayerAbi,
            functionName: 'debugSetRoot',
            args: [targetBlock, realRoot],
        });

        // Force Anvil to mine a new block containing our debug transaction
        await publicClient.request({ method: 'evm_mine' } as any);

        processedLogs.add(logKey);
        console.log(`Relayed state root via debug: ${txHash}. Polling for state commitment for block ${targetBlock}...`);

        // Robust polling check for state root commitment
        let verifiedRootFound = false;
        for (let i = 0; i < 10; i++) {
            const currentBlock = await publicClient.getBlockNumber();
            const currentRoot = await publicClient.readContract({
                address: callbackTarget,
                abi: axiomRelayerAbi,
                functionName: 'verifiedRoots',
                args: [targetBlock],
            }) as Hex;

            if (currentRoot !== '0x' + '00'.repeat(32)) {
                console.log(`[relayer] State root verified on-chain at block ${currentBlock}: ${currentRoot}`);
                verifiedRootFound = true;
                break;
            }

            console.log(`[relayer] Waiting for root commitment (attempt ${i + 1}/10, current node block: ${currentBlock})...`);
            await sleep(2000);
        }

        if (!verifiedRootFound) {
            throw new Error(`State root for block ${targetBlock} not found in Relayer after 20s timeout.`);
        }

        // AUTOMATION UPGRADE: Trigger Noir Prover and Submit Proof
        try {
            const proofData = await generateLoanProof({
                userAddress,
                blockNumber: targetBlock,
                chainId: Number(sourceChainId),
                rpcUrl,
                creditPolicyAddress: callbackTarget,
            });

            console.log(`[relayer] Proof generated for user ${userAddress}. Submitting to CreditVerifier at ${creditVerifier}...`);

            const gasPrice = await publicClient.getGasPrice();
            const proofHash = keccak256(proofData.proof);
            
            const submitArgs = [
                proofData.proof,
                proofData.publicInputs[0] as Hex,
                proofData.metadata.score,
                proofData.metadata.isSolvent,
                proofHash,
                proofData.metadata.nonce,
                getAddress(userAddress),
                proofData.stateRoot,
                BigInt(proofData.blockNumber),
            ] as const;

            const estimatedGas = await publicClient.estimateContractGas({
                address: creditVerifier,
                abi: creditVerifierAbi,
                functionName: 'verifyAndRegisterScore',
                args: submitArgs,
                account: account.address,
            });

            console.log(`[relayer] ZK Proof submission estimation:`, {
                gasPrice: `${gasPrice.toString()} wei`,
                estimatedGas: estimatedGas.toString(),
                totalCost: `${(gasPrice * estimatedGas).toString()} wei`,
                agentBalance: `${(await publicClient.getBalance({ address: account.address })).toString()} wei`,
            });

            const submitTxHash = await walletClient.writeContract({
                address: creditVerifier,
                abi: creditVerifierAbi,
                functionName: 'verifyAndRegisterScore',
                args: submitArgs,
                value: 0n,
            });

            console.log(`[relayer] Final ZK Proof submitted! Tx: ${submitTxHash}`);
        } catch (error) {
            console.error(`[relayer] Failed to automate proof submission:`, error);
        }
      }
    }

    lastScannedBlock = latestBlock;
    return latestBlock;
  }

  const loop = (async () => {
    let loopIterations = 0;

    while (!stopped) {
      try {
        if (lastScannedBlock === 0n) {
          try {
            lastScannedBlock = await publicClient.getBlockNumber();
          } catch {
            await sleep(POLL_INTERVAL_MS);
            continue;
          }
        }

        await pollOnce();
        loopIterations += 1;

        if (loopIterations % 5 === 0) {
          const heartbeatStart = config.startBlock ?? lastScannedBlock;
          console.log(`[relayer] Heartbeat: Scanning for Axiom queries from block ${heartbeatStart.toString()}...`);
        }
      } catch (error) {
        console.error(error);
      }

      if (!stopped) {
        await sleep(POLL_INTERVAL_MS);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done: loop,
  };
}

async function main() {
  await startAxiomRelayer();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}