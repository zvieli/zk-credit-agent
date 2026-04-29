import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, decodeAbiParameters, encodeFunctionData, getAddress, http, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { getAxiomV2QueryAddress } from '@axiom-crypto/client';
import { initBackendEnv, readFrontendDeploymentConfig } from './env.ts';

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

function resolveRpcUrl() {
  return process.env.ANVIL_RPC_URL || process.env.RPC_URL || process.env.PROOF_RPC_URL || 'http://127.0.0.1:8545';
}

function resolveSignerPrivateKey() {
  const privateKey = process.env.AXIOM_QUERY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('Missing AXIOM_QUERY_PRIVATE_KEY.');
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
      rpcUrls: {
        default: { http: [rpcUrl] },
        public: { http: [rpcUrl] },
      },
    },
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  const callbackTargetRaw = config.callbackTarget || process.env.AXIOM_CALLBACK_TARGET || process.env.CREDIT_POLICY_ADDRESS || deployment.creditPolicyAddress;
  if (!callbackTargetRaw) {
    throw new Error('Missing AXIOM_CALLBACK_TARGET or CREDIT_POLICY_ADDRESS.');
  }

  const callbackTarget = getAddress(callbackTargetRaw);
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

        let targetBlock: bigint;
        try {
          [targetBlock] = decodeAbiParameters([{ type: 'uint256' }], extraData);
        } catch {
          continue;
        }

        const block = await publicClient.getBlock({ blockNumber: targetBlock });
        const realRoot = block.stateRoot as Hex;
        const results = [realRoot];

        console.log(`[relayer] Found query for block ${targetBlock.toString()}. Relaying real root ${realRoot}....`);

        await publicClient.request({
          method: 'anvil_impersonateAccount',
          params: [axiomV2QueryAddress],
        } as any);

        await publicClient.request({
          method: 'anvil_setBalance',
          params: [axiomV2QueryAddress, '0x100000000000000000000'],
        } as any);

        const calldata = encodeFunctionData({
          abi: axiomCallbackAbi,
          functionName: 'axiomV2Callback',
          args: [sourceChainId, caller, querySchema, results, extraData],
        });

        const txHash = await publicClient.request({
          method: 'eth_sendTransaction',
          params: [{ from: axiomV2QueryAddress, to: callbackTarget, data: calldata }],
        } as any) as Hex;

        processedLogs.add(logKey);
        console.log(`Relayed Axiom callback from ${axiomV2QueryAddress} to ${callbackTarget}: ${txHash} (queryId ${queryId.toString()})`);
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