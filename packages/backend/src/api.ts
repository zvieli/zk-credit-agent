import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, createWalletClient, getAddress, http, type Chain } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { initBackendEnv } from './env.ts';
import { getUserFeaturesAndSignature } from './index.ts';
import { generateProof as generateBackendProof, generateLoanProof, requestAxiomRoot, resolveCreditPolicyAddress as resolveConfiguredCreditPolicyAddress } from './axiom_service.ts';
import { startAxiomRelayer } from './axiom_relayer.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

initBackendEnv();

type Hex = `0x${string}`;
const MAINNET_CHAIN_ID = 1;

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

const creditPolicyAbi = [
  {
    inputs: [
      { internalType: 'bytes', name: 'proof', type: 'bytes' },
      { internalType: 'bytes32', name: 'commitment', type: 'bytes32' },
      { internalType: 'uint32', name: 'score', type: 'uint32' },
      { internalType: 'bool', name: 'isSolvent', type: 'bool' },
      { internalType: 'bytes32', name: 'proofHash', type: 'bytes32' },
      { internalType: 'uint32', name: 'nonce', type: 'uint32' },
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'bytes32', name: 'stateRoot', type: 'bytes32' },
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
    ],
    name: 'verifyAndRegisterScore',
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
  rpcUrl?: string;
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

type RegisterScoreRequest = {
  proof?: Hex;
  commitment?: Hex;
  score?: number;
  isSolvent?: boolean;
  proofHash?: Hex;
  nonce?: number;
  userAddress?: string;
  stateRoot?: Hex;
  blockNumber?: string | number | bigint;
  creditPolicyAddress?: string;
};

type GenerateProofRequest = {
  circuitName?: 'account' | 'storage' | 'combined';
  inputs?: Record<string, unknown>;
};

type RequestAxiomRootRequest = {
  userAddress?: string;
  blockNumber?: string | number | bigint;
  chainId?: number;
  rpcUrl?: string;
  creditPolicyAddress?: string;
  axiomV2QueryAddress?: string;
  stateRoot?: string;
};

type GenerateLoanProofRequest = {
  userAddress?: string;
  blockNumber?: string | number | bigint;
  nonce?: number;
  chainId?: number;
  rpcUrl?: string;
  creditPolicyAddress?: string;
};

function resolveBackendPort() {
  return Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001);
}

function resolveProofRpcUrl() {
  if (process.env.ANVIL_RPC_URL) {
    return process.env.ANVIL_RPC_URL;
  }

  if (process.env.PROOF_RPC_URL) {
    return process.env.PROOF_RPC_URL;
  }

  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }

  return 'http://127.0.0.1:8545';
}

function resolveTransactionRpcUrl() {
  return process.env.ANVIL_RPC_URL ?? process.env.RPC_URL ?? process.env.TX_RPC_URL ?? 'http://127.0.0.1:8545';
}

function resolveRuntimeRpcChain(rpcUrl: string): Chain {
  return {
    ...mainnet,
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
  };
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

function readJsonBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();

      if (!rawBody) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Invalid JSON body'));
      }
    });
    request.on('error', reject);
  });
}

function parseNumber(value: string | undefined, fallback?: number) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBigIntValue(value: string | number | bigint | undefined) {
  if (value === undefined || value === '') {
    return undefined;
  }

  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? BigInt(Math.floor(value)) : undefined;
  }

  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
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

function normalizeRoutePath(pathname: string) {
  return pathname.startsWith('/api/') ? pathname.slice(4) : pathname;
}

async function handleRequestAxiomRoot(body: RequestAxiomRootRequest, response: ServerResponse) {

  if (!body.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
  }

  const blockNumber = parseBigIntValue(body.blockNumber);
  if (blockNumber === undefined || blockNumber <= 0n) {
    sendJson(response, 400, { error: 'Missing blockNumber.' });
    return;
  }

  if (typeof body.stateRoot === 'string') {
    const stateRoot = body.stateRoot.trim();

    if (!stateRoot || /^0x0+$/i.test(stateRoot)) {
      sendJson(response, 400, { error: 'stateRoot cannot be empty or zero.' });
      return;
    }
  }

  try {
    const deployment = (await import('./env.ts')).readFrontendDeploymentConfig();
    const chainId = body.chainId ?? deployment.chainId ?? 31337;
    const creditPolicyAddress = resolveConfiguredCreditPolicyAddress(body.creditPolicyAddress);
    const result = await requestAxiomRoot({
      userAddress: tryGetAddress(body.userAddress, 'userAddress'),
      blockNumber,
      chainId,
      ...(body.rpcUrl ? { rpcUrl: body.rpcUrl } : {}),
      creditPolicyAddress,
      ...(body.axiomV2QueryAddress ? { axiomV2QueryAddress: body.axiomV2QueryAddress } : {}),
    });

    sendJson(response, 200, {
      ...result,
      queryId: result.queryId.toString(),
      blockNumber: result.blockNumber.toString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to request Axiom root.';
    sendJson(response, 400, { error: message });
  }
}

async function handleGenerateLoanProof(parsedBody: GenerateLoanProofRequest | undefined, response: ServerResponse) {
  if (!parsedBody || typeof parsedBody !== 'object') {
    sendJson(response, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsedBody.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
  }

  const blockNumber = parseBigIntValue(parsedBody.blockNumber);
  if (blockNumber === undefined || blockNumber <= 0n) {
    sendJson(response, 400, { error: 'Missing blockNumber.' });
    return;
  }

  try {
    const deployment = (await import('./env.ts')).readFrontendDeploymentConfig();
    const chainId = parsedBody.chainId ?? deployment.chainId ?? 31337;
    const creditPolicyAddress = resolveConfiguredCreditPolicyAddress(parsedBody.creditPolicyAddress);
    const proof = await generateLoanProof({
      userAddress: tryGetAddress(parsedBody.userAddress, 'userAddress'),
      blockNumber,
      chainId,
      ...(parsedBody.nonce !== undefined ? { nonce: parsedBody.nonce } : {}),
      ...(parsedBody.rpcUrl ? { rpcUrl: parsedBody.rpcUrl } : {}),
      creditPolicyAddress,
    });

    sendJson(response, 200, {
      proof: proof.proof,
      publicInputs: proof.publicInputs,
      stateRoot: proof.stateRoot,
      blockNumber: proof.blockNumber.toString(),
      creditPolicyAddress: proof.creditPolicyAddress,
      metadata: proof.metadata,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proof generation failed.';
    const statusCode = message.includes('not verified on-chain') ? 409 : 400;
    sendJson(response, statusCode, { error: message });
  }
}

async function handleGetProofData(request: IncomingMessage, response: ServerResponse, parsedBody?: Partial<ProofDataRequest>) {
  const url = new URL(request.url ?? '/api/get-proof-data', 'http://localhost');
  const body: Partial<ProofDataRequest> = parsedBody ? { ...parsedBody } : {};

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
      const deployment = (await import('./env.ts')).readFrontendDeploymentConfig();
      body.chainId = deployment.chainId ?? 31337;
    }

    const rpcUrl = url.searchParams.get('rpcUrl') ?? undefined;
    if (rpcUrl) {
      body.rpcUrl = rpcUrl;
    }
    } else {
    if (!parsedBody) {
      sendJson(response, 400, { error: 'Invalid JSON body' });
      return;
    }
    }

    const overrides = body.overrides && typeof body.overrides === 'object' ? { ...body.overrides } : undefined;

    if (!body.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
    }

    try {
    const deployment = (await import('./env.ts')).readFrontendDeploymentConfig();
    const contractAddress = tryGetAddress(body.contractAddress, 'contractAddress');
    const chainId = body.chainId ?? deployment.chainId ?? 31337;
    const nonce = body.nonce ?? Math.floor(Date.now() / 1000) >>> 0;

    const proofData = await getUserFeaturesAndSignature(
      tryGetAddress(body.userAddress, 'userAddress'),
      contractAddress,
      chainId,
      nonce,
      body.rpcUrl ?? resolveTransactionRpcUrl(),
      overrides,
    );

    sendJson(response, 200, proofData);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    sendJson(response, 400, { error: message });
  }
}

/**
 * @deprecated This endpoint is for debugging only.
 * The primary flow should now use the user's connected wallet to sign and submit scores.
 */
async function handleSubmitScore(parsedBody: SubmitScoreRequest | undefined, response: ServerResponse) {
  if (!parsedBody || typeof parsedBody !== 'object') {
    sendJson(response, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsedBody.userAddress) {
    sendJson(response, 400, { error: 'Missing userAddress.' });
    return;
  }

  if (parsedBody.score === undefined || Number.isNaN(parsedBody.score)) {
    sendJson(response, 400, { error: 'Missing score.' });
    return;
  }

  try {
    const scoreRegistryAddress = resolveScoreRegistryAddress(parsedBody.scoreRegistryAddress);
    const privateKey = process.env.AGENT_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('AGENT_PRIVATE_KEY not configured on server.');
    }
    const account = privateKeyToAccount(privateKey as Hex);
    const rpcUrl = resolveTransactionRpcUrl();
    const publicClient = createPublicClient({
      chain: resolveRuntimeRpcChain(rpcUrl),
      transport: http(rpcUrl, { timeout: 300000 }),
    });
    const rpcChain = resolveRuntimeRpcChain(rpcUrl);
    const walletClient = createWalletClient({
      account,
      chain: rpcChain,
      transport: http(rpcUrl, { timeout: 300000 }),
    });

    const txHash = await walletClient.writeContract({
      address: scoreRegistryAddress,
      abi: scoreRegistryAbi,
      functionName: 'setScore',
      args: [tryGetAddress(parsedBody.userAddress, 'userAddress'), Math.max(0, Math.floor(parsedBody.score))],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    sendJson(response, 200, { txHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    sendJson(response, 400, { error: message });
  }
}

/**
 * @deprecated This endpoint is for debugging only.
 * The primary flow should now use the user's connected wallet to sign and submit scores.
 */
async function handleRegisterScore(parsedBody: RegisterScoreRequest | undefined, response: ServerResponse) {
  if (!parsedBody || typeof parsedBody !== 'object') {
    sendJson(response, 400, { error: 'Invalid JSON body' });
    return;
  }

  const requiredFields: Array<keyof RegisterScoreRequest> = ['proof', 'commitment', 'score', 'isSolvent', 'proofHash', 'nonce', 'userAddress', 'stateRoot', 'blockNumber'];
  for (const field of requiredFields) {
    if (parsedBody[field] === undefined || parsedBody[field] === null) {
      sendJson(response, 400, { error: `Missing ${String(field)}.` });
      return;
    }
  }

  try {
    const creditPolicyAddress = resolveCreditPolicyAddress(parsedBody.creditPolicyAddress);
    const proof = parsedBody.proof as Hex;
    const commitment = parsedBody.commitment as Hex;
    const score = Math.max(0, Math.floor(parsedBody.score as number));
    const isSolvent = Boolean(parsedBody.isSolvent);
    const proofHash = parsedBody.proofHash as Hex;
    const nonce = Math.max(0, Math.floor(parsedBody.nonce as number));
    const userAddress = tryGetAddress(parsedBody.userAddress, 'userAddress');
    const stateRoot = parsedBody.stateRoot as Hex;
    const blockNumber = BigInt(parsedBody.blockNumber as string | number | bigint);
    
    const privateKey = process.env.AGENT_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('AGENT_PRIVATE_KEY not configured on server.');
    }
    const account = privateKeyToAccount(privateKey as Hex);
    const rpcUrl = resolveTransactionRpcUrl();
    const publicClient = createPublicClient({
      chain: resolveRuntimeRpcChain(rpcUrl),
      transport: http(rpcUrl, { timeout: 300000 }),
    });
    const rpcChain = resolveRuntimeRpcChain(rpcUrl);
    const walletClient = createWalletClient({
      account,
      chain: rpcChain,
      transport: http(rpcUrl, { timeout: 300000 }),
    });

    const txHash = await walletClient.writeContract({
      address: creditPolicyAddress,
      abi: creditPolicyAbi,
      functionName: 'verifyAndRegisterScore',
      args: [
        proof,
        commitment,
        score,
        isSolvent,
        proofHash,
        nonce,
        userAddress,
        stateRoot,
        blockNumber,
      ],
    });

    await publicClient.waitForTransactionReceipt({ hash: txHash });

    sendJson(response, 200, { txHash });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    sendJson(response, 400, { error: message });
  }
}

async function handleGenerateProof(parsedBody: GenerateProofRequest | undefined, response: ServerResponse) {
  if (!parsedBody || typeof parsedBody !== 'object') {
    sendJson(response, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!parsedBody.inputs || typeof parsedBody.inputs !== 'object') {
    sendJson(response, 400, { error: 'Missing inputs.' });
    return;
  }

  try {
    const circuitName = parsedBody.circuitName === 'account' || parsedBody.circuitName === 'storage' || parsedBody.circuitName === 'combined'
      ? parsedBody.circuitName
      : 'combined';
    const { metadata: _metadata, ...witnessInputs } = parsedBody.inputs as { metadata?: unknown } & Record<string, unknown>;
    const proofData = await generateBackendProof(circuitName, witnessInputs);

    sendJson(response, 200, proofData);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Proof generation failed.';
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
      const routePath = normalizeRoutePath(requestUrl.pathname);

      let parsedBody: unknown;
      if (request.method === 'POST') {
        try {
          parsedBody = await readJsonBody(request);
        } catch {
          sendJson(response, 400, { error: 'Invalid JSON body' });
          return;
        }

        if (parsedBody === undefined) {
          sendJson(response, 400, { error: 'Invalid JSON body' });
          return;
        }
      }

      if (routePath === '/get-proof-data' && (request.method === 'GET' || request.method === 'POST')) {
        await handleGetProofData(request, response, parsedBody as Partial<ProofDataRequest> | undefined);
        return;
      }

      if (routePath === '/generate-proof' && request.method === 'POST') {
        await handleGenerateProof(parsedBody as GenerateProofRequest, response);
        return;
      }

      if (routePath === '/submit-score' && request.method === 'POST') {
        await handleSubmitScore(parsedBody as SubmitScoreRequest, response);
        return;
      }

      if (routePath === '/register-score' && request.method === 'POST') {
        await handleRegisterScore(parsedBody as RegisterScoreRequest, response);
        return;
      }

      if (routePath === '/request-axiom-root' && request.method === 'POST') {
        await handleRequestAxiomRoot(parsedBody as RequestAxiomRootRequest, response);
        return;
      }

      if (routePath === '/generate-loan-proof' && request.method === 'POST') {
        await handleGenerateLoanProof(parsedBody as GenerateLoanProofRequest, response);
        return;
      }

      if (routePath === '/health') {
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
    void startAxiomRelayer({ callbackTarget: resolveConfiguredCreditPolicyAddress() }).catch((error) => {
      console.error('[relayer] Critical failure:', error);
    });
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