import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { createPublicClient, createWalletClient, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserFeaturesAndSignature } from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

type Hex = `0x${string}`;

const scoreRegistryAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'uint32', name: 'score', type: 'uint32' },
    ],
    name: 'setScore',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

type ProofDataRequest = {
  userAddress?: string;
  contractAddress?: string;
  chainId?: number;
  nonce?: number;
  overrides?: {
    blockNumber?: bigint;
    stateRoot?: `0x${string}`;
    storageProofAddress?: string;
    storageProofSlot?: `0x${string}`;
  };
};

type SubmitScoreRequest = {
  userAddress?: string;
  score?: number;
  scoreRegistryAddress?: string;
};

function resolveBackendPort() {
  return Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001);
}

function resolveProofRpcUrl() {
  if (process.env.PROOF_RPC_URL) {
    return process.env.PROOF_RPC_URL;
  }

  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }

  if (process.env.ALCHEMY_API_KEY) {
    return `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }

  return 'http://127.0.0.1:8545';
}

function resolveTransactionRpcUrl() {
  return process.env.RPC_URL ?? process.env.TX_RPC_URL ?? 'http://127.0.0.1:8545';
}

function resolveCreditPolicyAddress(contractAddress?: string) {
  const resolvedAddress = contractAddress ?? process.env.CREDIT_POLICY_ADDRESS;
  if (!resolvedAddress) {
    throw new Error('Missing CREDIT_POLICY_ADDRESS.');
  }

  return getAddress(resolvedAddress);
}

function resolveScoreRegistryAddress(address?: string) {
  const resolvedAddress = address ?? process.env.SCORE_REGISTRY_ADDRESS;
  if (!resolvedAddress) {
    throw new Error('Missing SCORE_REGISTRY_ADDRESS.');
  }

  return getAddress(resolvedAddress);
}

function resolveAgentPrivateKey() {
  const privateKey = process.env.AGENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('Missing AGENT_PRIVATE_KEY.');
  }

  return privateKey as Hex;
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function parseJsonBody<T>(request: IncomingMessage): Promise<T> {
  const rawBody = await readRequestBody(request);
  if (!rawBody) {
    return {} as T;
  }

  return JSON.parse(rawBody) as T;
}

function parseNumber(value: string | undefined, fallback?: number) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tryGetAddress(value: string | undefined, fieldName: string) {
  if (!value) {
    throw new Error(`Missing ${fieldName}.`);
  }

  try {
    return getAddress(value);
  } catch {
    throw new Error(`Invalid ${fieldName}.`);
  }
}

async function handleGetProofData(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/api/get-proof-data', 'http://localhost');
  const body: Partial<ProofDataRequest> = {};

  if (request.method === 'GET') {
    const userAddress = url.searchParams.get('userAddress') ?? undefined;
    const contractAddress = url.searchParams.get('contractAddress') ?? undefined;
    const chainId = parseNumber(url.searchParams.get('chainId') ?? undefined);
    const nonce = parseNumber(url.searchParams.get('nonce') ?? undefined);

    if (userAddress) {
      body.userAddress = userAddress;
    }

    if (contractAddress) {
      body.contractAddress = contractAddress;
    }

    if (chainId !== undefined) {
      body.chainId = chainId;
    }

    if (nonce !== undefined) {
      body.nonce = nonce;
    }
  } else {
    Object.assign(body, await parseJsonBody<ProofDataRequest>(request));
  }

  const overrides = body.overrides && typeof body.overrides === 'object' ? { ...body.overrides } : undefined;

  if (!body.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
  }

  try {
    const contractAddress = tryGetAddress(body.contractAddress, 'contractAddress');
    const chainId = body.chainId ?? Number(process.env.CHAIN_ID ?? 1);
    const nonce = body.nonce ?? Math.floor(Date.now() / 1000) >>> 0;

    const proofData = await getUserFeaturesAndSignature(
      tryGetAddress(body.userAddress, 'userAddress'),
      contractAddress,
      chainId,
      nonce,
      resolveProofRpcUrl(),
      overrides,
    );

    sendJson(response, 200, proofData);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    sendJson(response, 400, { error: message });
  }
}

async function handleSubmitScore(request: IncomingMessage, response: ServerResponse) {
  const body = await parseJsonBody<SubmitScoreRequest>(request);

  if (!body.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
  }

  if (body.score === undefined || Number.isNaN(body.score)) {
    sendJson(response, 400, { error: 'Missing score.' });
    return;
  }

  try {
    const scoreRegistryAddress = resolveScoreRegistryAddress(body.scoreRegistryAddress);
    const account = privateKeyToAccount(resolveAgentPrivateKey());
    const rpcUrl = resolveTransactionRpcUrl();
    const publicClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl, { timeout: 300000 }),
    });
    const walletClient = createWalletClient({
      account,
      chain: mainnet,
      transport: http(rpcUrl, { timeout: 300000 }),
    });

    const txHash = await walletClient.writeContract({
      address: scoreRegistryAddress,
      abi: scoreRegistryAbi,
      functionName: 'setScore',
      args: [tryGetAddress(body.userAddress, 'userAddress'), Math.max(0, Math.floor(body.score))],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    sendJson(response, 200, { txHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    sendJson(response, 400, { error: message });
  }
}

export function startApiServer(port = resolveBackendPort()) {
  const server = createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');

      if (requestUrl.pathname === '/api/get-proof-data' && (request.method === 'GET' || request.method === 'POST')) {
        await handleGetProofData(request, response);
        return;
      }

      if (requestUrl.pathname === '/api/submit-score' && request.method === 'POST') {
        await handleSubmitScore(request, response);
        return;
      }

      if (requestUrl.pathname === '/api/health') {
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Server error';
      sendJson(response, 500, { error: message });
    }
  });

  server.listen(port, () => {
    console.log(`Backend API listening on http://127.0.0.1:${port}`);
  });

  return server;
}

async function main() {
  startApiServer();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}