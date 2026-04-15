import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createPublicClient, createWalletClient, encodeAbiParameters, getAddress, http, parseAbiParameters } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getAxiomV2QueryAddress } from '@axiom-crypto/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

type Hex = `0x${string}`;

type AxiomRelayerConfig = {
  rpcUrl?: string;
  chainId?: number;
  axiomV2QueryAddress?: string;
  callbackTarget: string;
  caller: string;
  sourceChainId?: number;
  querySchema?: Hex;
  stateRoot: Hex;
  extraData?: Hex;
  results?: Hex[];
  startBlock?: bigint;
  pollingIntervalMs?: number;
  signerPrivateKey?: Hex;
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
  return process.env.RPC_URL || process.env.PROOF_RPC_URL || 'http://127.0.0.1:8545';
}

function resolveSignerPrivateKey() {
  const privateKey = process.env.AXIOM_QUERY_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error('Missing AXIOM_QUERY_PRIVATE_KEY.');
  }

  return privateKey as Hex;
}

function buildDefaultExtraData(blockNumber: bigint) {
  return encodeAbiParameters(parseAbiParameters('uint256'), [blockNumber]);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startAxiomRelayer(config: AxiomRelayerConfig) {
  const rpcUrl = config.rpcUrl || resolveRpcUrl();
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  const signerAccount = privateKeyToAccount(config.signerPrivateKey || resolveSignerPrivateKey());
  const walletClient = createWalletClient({
    account: signerAccount,
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  const axiomV2QueryAddress = getAddress(config.axiomV2QueryAddress || getAxiomV2QueryAddress(String(config.chainId ?? 1)));
  const callbackTarget = getAddress(config.callbackTarget);
  const caller = getAddress(config.caller);
  const sourceChainId = BigInt(config.sourceChainId ?? config.chainId ?? 1);
  const querySchema = config.querySchema || ('0x' + '00'.repeat(32)) as Hex;
  const results = config.results && config.results.length > 0 ? config.results : [config.stateRoot];
  const pollingIntervalMs = config.pollingIntervalMs ?? 4000;
  let lastScannedBlock = config.startBlock ?? (await publicClient.getBlockNumber());
  const processedLogs = new Set<string>();
  let stopped = false;

  async function pollOnce() {
    const latestBlock = await publicClient.getBlockNumber();

    if (latestBlock <= lastScannedBlock) {
      return;
    }

    const fromBlock = lastScannedBlock + 1n;
    const logs = await publicClient.getLogs({
      address: axiomV2QueryAddress,
      fromBlock,
      toBlock: latestBlock,
    });

    lastScannedBlock = latestBlock;

    for (const log of logs) {
      const logKey = `${log.transactionHash ?? '0x'}:${log.logIndex ?? 0n}`;
      if (processedLogs.has(logKey)) {
        continue;
      }

      const extraData = config.extraData || buildDefaultExtraData(log.blockNumber ?? latestBlock);
      const txHash = await walletClient.writeContract({
        address: callbackTarget,
        abi: axiomCallbackAbi,
        functionName: 'axiomV2Callback',
        args: [sourceChainId, caller, querySchema, results, extraData],
      });

      processedLogs.add(logKey);
      console.log(`Relayed Axiom callback from ${axiomV2QueryAddress} to ${callbackTarget}: ${txHash}`);
    }
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await pollOnce();
      } catch (error) {
        console.error(error);
      }

      if (!stopped) {
        await sleep(pollingIntervalMs);
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
  const callbackTarget = process.env.AXIOM_CALLBACK_TARGET || process.env.CREDIT_POLICY_ADDRESS;
  const stateRoot = process.env.AXIOM_VERIFIED_STATE_ROOT as Hex | undefined;

  if (!callbackTarget) {
    throw new Error('Missing AXIOM_CALLBACK_TARGET or CREDIT_POLICY_ADDRESS.');
  }

  if (!stateRoot) {
    throw new Error('Missing AXIOM_VERIFIED_STATE_ROOT.');
  }

  const relayerConfig: Parameters<typeof startAxiomRelayer>[0] = {
    rpcUrl: resolveRpcUrl(),
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : 1,
    callbackTarget,
    caller: process.env.AXIOM_CALLBACK_CALLER || callbackTarget,
    sourceChainId: process.env.AXIOM_SOURCE_CHAIN_ID ? Number(process.env.AXIOM_SOURCE_CHAIN_ID) : 1,
    stateRoot,
    signerPrivateKey: process.env.AXIOM_QUERY_PRIVATE_KEY as Hex | undefined,
  };

  if (process.env.AXIOM_V2_QUERY_ADDRESS) {
    relayerConfig.axiomV2QueryAddress = process.env.AXIOM_V2_QUERY_ADDRESS;
  }

  if (process.env.AXIOM_QUERY_SCHEMA) {
    relayerConfig.querySchema = process.env.AXIOM_QUERY_SCHEMA as Hex;
  }

  if (process.env.AXIOM_CALLBACK_EXTRA_DATA) {
    relayerConfig.extraData = process.env.AXIOM_CALLBACK_EXTRA_DATA as Hex;
  }

  if (process.env.AXIOM_CALLBACK_RESULTS) {
    relayerConfig.results = process.env.AXIOM_CALLBACK_RESULTS.split(',').map((value) => value.trim()) as Hex[];
  }

  await startAxiomRelayer(relayerConfig);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}