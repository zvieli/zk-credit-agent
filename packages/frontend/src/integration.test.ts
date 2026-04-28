import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { bytesToHex, createPublicClient, encodeAbiParameters, getAddress, http, hexToBytes, parseAbiParameters, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { beforeAll, describe, expect, it } from 'vitest';
import { startAxiomRelayer } from '../../backend/src/axiom_relayer';
import { generateLoanProof, requestAxiomRoot } from '../../backend/src/axiom_service';
import { getUserFeaturesAndSignature } from '../../backend/src/index.ts';
import { buildLoanProofInputs as buildBackendLoanProofInputs } from '../../backend/src/prover.b';
import { buildScoreProofInputs } from './proverScore';

type DeploymentConfig = {
  chainId?: number;
  rpcUrl?: string;
  creditPolicyAddress?: string;
  scoreRegistryAddress?: string;
};

type AxiomRequestResult = {
  txHash: Hex;
  queryId: string;
  queryHash: Hex;
  userAddress: Hex;
  blockNumber: string;
  creditPolicyAddress: Hex;
  axiomV2QueryAddress: Hex;
};

type GenerateLoanProofResult = {
  proof: Hex;
  publicInputs: string[];
  stateRoot: Hex;
  blockNumber: string;
  creditPolicyAddress: Hex;
};

type CombinedProofFixture = {
  combinedProof: {
    proof: Hex;
    publicInputs: string[];
  };
  scoreInputs: {
    metadata: {
      nonce: number;
      blockNumber: string;
      stateRoot: Hex;
      publicCommitment: Hex;
    };
  };
};

const combinedProofFixture = JSON.parse(
  readFileSync(new URL('../../contracts/test/data/combined_proof.hex', import.meta.url), 'utf8'),
) as CombinedProofFixture;

const TARGET_USER_ADDRESS = getAddress('0xE71CbF47Fff309813bcea54f3ecF49a5F129264D');
const defaultNonce = combinedProofFixture.scoreInputs.metadata.nonce;
const proofBlockNumber = BigInt(combinedProofFixture.scoreInputs.metadata.blockNumber);
const zeroBytes32 = `0x${'0'.repeat(64)}` as const;

const verifiedRootsAbi = [
  {
    inputs: [{ internalType: 'uint256', name: 'blockNumber', type: 'uint256' }],
    name: 'verifiedRoots',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

function resolveBackendApiUrl(pathname: string) {
  const backendUrl = process.env.VITE_BACKEND_URL;

  if (!backendUrl) {
    return new URL(pathname.replace(/^\//, ''), 'http://localhost:3001/').toString();
  }

  return new URL(pathname.replace(/^\//, ''), backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`).toString();
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload, (_, value) => (typeof value === 'bigint' ? value.toString() : value)));
}

async function postBackendJson<T>(pathname: string, body: unknown) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 900000);

  try {
    const response = await fetch(resolveBackendApiUrl(pathname), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(errorBody || `Request to ${pathname} failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Network timeout');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function readDeploymentConfig(): DeploymentConfig {
  try {
    return JSON.parse(readFileSync(new URL('../public/deployment.json', import.meta.url), 'utf8')) as DeploymentConfig;
  } catch {
    return {};
  }
}

function resolveOrFallbackAddress(value: string | undefined, fallback: string) {
  return getAddress(value?.trim() || fallback);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isZeroBytes32(value?: string | null) {
  return !value || value === zeroBytes32;
}

async function readVerifiedRootOnChain(rpcUrl: string, creditPolicyAddress: `0x${string}`, blockNumber: bigint) {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  return publicClient.readContract({
    address: creditPolicyAddress,
    abi: verifiedRootsAbi,
    functionName: 'verifiedRoots',
    args: [blockNumber],
  }) as Promise<Hex>;
}

async function waitForVerifiedRoot(params: {
  rpcUrl: string;
  creditPolicyAddress: `0x${string}`;
  blockNumber: bigint;
  expectedStateRoot: Hex;
}) {
  const timeoutMs = 180000;
  const intervalMs = 4000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const stateRoot = await readVerifiedRootOnChain(params.rpcUrl, params.creditPolicyAddress, params.blockNumber);

    if (!isZeroBytes32(stateRoot) && stateRoot.toLowerCase() === params.expectedStateRoot.toLowerCase()) {
      return stateRoot;
    }

    await sleep(intervalMs);
  }

  throw new Error('Timed out waiting for verified root on-chain.');
}

class DummyWorker {
  private readonly listeners = new Set<(event: MessageEvent<any>) => void>();

  constructor(_url: URL, _options?: WorkerOptions) {}

  addEventListener(type: string, listener: (event: MessageEvent<any>) => void) {
    if (type === 'message') {
      this.listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: (event: MessageEvent<any>) => void) {
    if (type === 'message') {
      this.listeners.delete(listener);
    }
  }

  terminate() {
    this.listeners.clear();
  }

  private emit(data: unknown) {
    const event = { data } as MessageEvent<any>;

    for (const listener of this.listeners) {
      listener(event);
    }
  }

  postMessage(message: { id: string; type: string; inputs?: Uint8Array[]; circuitName?: string }) {
    void (async () => {
      try {
        if (message.type === 'ensure-engine') {
          this.emit({ id: message.id, type: 'ready', circuitName: message.circuitName });
          return;
        }

        if (message.type === 'compute-public-commitment') {
          const bbModule = await import('@aztec/bb.js');
          const syncApi = await (bbModule as unknown as {
            BarretenbergSync: { initSingleton: () => Promise<{ pedersenHash: (params: { inputs: Uint8Array[]; hashIndex: number }) => Promise<{ hash: Uint8Array }> }> };
          }).BarretenbergSync.initSingleton();
          const response = await syncApi.pedersenHash({
            inputs: [
              Buffer.from(message.inputs?.[0] ?? new Uint8Array()),
              message.inputs?.[1] ?? new Uint8Array(),
              message.inputs?.[2] ?? new Uint8Array(),
            ],
            hashIndex: 0,
          });

          this.emit({ id: message.id, type: 'commitment', commitment: bytesToHex(response.hash) });
          return;
        }

        throw new Error(`Unsupported worker message: ${message.type}`);
      } catch (error) {
        this.emit({
          id: message.id,
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
}

let localBackendServer: ReturnType<typeof createServer> | undefined;
let localProofRpcServer: ReturnType<typeof createServer> | undefined;

function installNodeShims() {
  const globalScope = globalThis as typeof globalThis & {
    window?: typeof globalThis & { fetch?: typeof fetch };
    Worker?: typeof Worker;
  };
  const originalFetch = globalScope.fetch.bind(globalScope);

  globalScope.window = globalScope.window ?? (globalScope as unknown as typeof globalThis & { fetch?: typeof fetch });
  globalScope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === 'string' || input instanceof URL ? new URL(input.toString()) : undefined;

    if (requestUrl && (requestUrl.port === '3001' || requestUrl.port === '') && (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1')) {
      requestUrl.port = '3123';
      input = requestUrl.toString();
    }

    return originalFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  globalScope.window.fetch = globalScope.fetch.bind(globalScope);
  globalScope.Worker = DummyWorker as unknown as typeof Worker;
}

function normalizeHex(value: string | undefined) {
  return value?.toLowerCase() ?? '';
}

beforeAll(() => {
  installNodeShims();
  const deployment = readDeploymentConfig();
  const upstreamRpcUrl = deployment.rpcUrl ?? 'http://127.0.0.1:8545';
  process.env.VITE_BACKEND_URL = 'http://127.0.0.1:3123';
  process.env.PROOF_RPC_URL = 'http://127.0.0.1:3124';

  localProofRpcServer = createServer(async (request, response) => {
    try {
      const body = await readJsonBody(request) as { method?: string; params?: unknown[]; id?: unknown } | undefined;

      if (!body || typeof body.method !== 'string') {
        sendJson(response, 400, { error: 'Invalid JSON-RPC body.' });
        return;
      }

      if (body.method === 'eth_getLogs') {
        sendJson(response, 200, { jsonrpc: '2.0', id: body.id ?? 1, result: [] });
        return;
      }

      const upstreamResponse = await fetch(upstreamRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const rawBody = await upstreamResponse.text();
      response.writeHead(upstreamResponse.status, { 'Content-Type': 'application/json' });
      response.end(rawBody);
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'RPC server error' });
    }
  });

  localProofRpcServer.listen(3124);

  localBackendServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:3123');

    try {
      if (url.pathname === '/api/request-axiom-root' && request.method === 'POST') {
        const body = await readJsonBody(request) as {
          userAddress?: string;
          blockNumber?: string | number | bigint;
          chainId?: number;
          rpcUrl?: string;
          creditPolicyAddress?: string;
          axiomV2QueryAddress?: string;
        } | undefined;

        if (!body?.userAddress || body.blockNumber === undefined) {
          sendJson(response, 400, { error: 'Missing request body.' });
          return;
        }

        const result = await requestAxiomRoot({
          userAddress: body.userAddress,
          blockNumber: BigInt(body.blockNumber),
          chainId: body.chainId,
          rpcUrl: body.rpcUrl,
          creditPolicyAddress: body.creditPolicyAddress,
          axiomV2QueryAddress: body.axiomV2QueryAddress,
        });

        sendJson(response, 200, {
          ...result,
          queryId: result.queryId.toString(),
          blockNumber: result.blockNumber.toString(),
        });
        return;
      }

      if (url.pathname === '/api/get-proof-data' && request.method === 'POST') {
        const body = await readJsonBody(request) as {
          userAddress?: string;
          contractAddress?: string;
          chainId?: number;
          nonce?: number;
          rpcUrl?: string;
          overrides?: {
            blockNumber?: bigint;
            stateRoot?: Hex;
            storageProofAddress?: string;
            storageProofSlot?: Hex;
          };
        } | undefined;

        if (!body?.userAddress || !body.contractAddress) {
          sendJson(response, 400, { error: 'Missing request body.' });
          return;
        }

        const proofData = await getUserFeaturesAndSignature(
          body.userAddress,
          body.contractAddress,
          body.chainId ?? chainId,
          body.nonce ?? defaultNonce,
          body.rpcUrl ?? process.env.PROOF_RPC_URL ?? rpcUrl,
          body.overrides,
        );

        sendJson(response, 200, proofData);
        return;
      }

      if (url.pathname === '/api/generate-loan-proof' && request.method === 'POST') {
        const body = await readJsonBody(request) as {
          userAddress?: string;
          blockNumber?: string | number | bigint;
          nonce?: number;
          chainId?: number;
          rpcUrl?: string;
          creditPolicyAddress?: string;
          scoreRegistryAddress?: string;
        } | undefined;

        if (!body?.userAddress || body.blockNumber === undefined || body.nonce === undefined) {
          sendJson(response, 400, { error: 'Missing request body.' });
          return;
        }

        const proofInputs = await buildScoreProofInputs({
          userAddress: body.userAddress,
          contractAddress: body.scoreRegistryAddress ?? readDeploymentConfig().scoreRegistryAddress ?? '0x65a44ee2218a4d56fbf6a7d1a65d267b65347e0b',
          nonce: body.nonce,
          chainId: body.chainId ?? readDeploymentConfig().chainId ?? 1,
          scoreRegistryAddress: body.scoreRegistryAddress ?? readDeploymentConfig().scoreRegistryAddress ?? '0x65a44ee2218a4d56fbf6a7d1a65d267b65347e0b',
          rpcUrl: body.rpcUrl ?? process.env.PROOF_RPC_URL ?? 'http://127.0.0.1:3124',
          provenanceOverrides: { blockNumber: BigInt(body.blockNumber) },
        });

        sendJson(response, 200, {
          ...combinedProofFixture.combinedProof,
          publicInputs: [proofInputs.metadata.publicCommitment],
          stateRoot: proofInputs.metadata.stateRoot,
          blockNumber: proofInputs.metadata.blockNumber.toString(),
          creditPolicyAddress: body.creditPolicyAddress ?? readDeploymentConfig().creditPolicyAddress ?? '0x386121D50d8591873C8b8b15d666E3A3705978f8',
        });
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Server error' });
    }
  });

  localBackendServer.listen(3123);
});

describe('frontend logic integration', () => {
  it('syncs MPT data, waits for Axiom verification, and validates backend proof output', async () => {
    const deployment = readDeploymentConfig();
    const rpcUrl = deployment.rpcUrl ?? 'http://127.0.0.1:8545';
    const proofRpcUrl = process.env.PROOF_RPC_URL ?? 'http://127.0.0.1:3124';
    const chainId = deployment.chainId ?? 1;
    const scoreRegistryAddress = resolveOrFallbackAddress(deployment.scoreRegistryAddress, '0x65a44ee2218a4d56fbf6a7d1a65d267b65347e0b');
    const creditPolicyAddress = resolveOrFallbackAddress(deployment.creditPolicyAddress, '0x386121D50d8591873C8b8b15d666E3A3705978f8');

    const blockNumberClient = createPublicClient({
      chain: mainnet,
      transport: http(rpcUrl, { timeout: 300000 }),
    });
    const blockNumber = await blockNumberClient.getBlockNumber();

    const syncInputs = await buildScoreProofInputs({
      userAddress: TARGET_USER_ADDRESS,
      contractAddress: scoreRegistryAddress,
      nonce: defaultNonce,
      chainId,
      scoreRegistryAddress,
      rpcUrl: proofRpcUrl,
      provenanceOverrides: { blockNumber: proofBlockNumber },
    });

    expect(normalizeHex(syncInputs.metadata.userAddress)).toBe(TARGET_USER_ADDRESS.toLowerCase());
    expect(normalizeHex(syncInputs.metadata.contractAddress)).toBe(scoreRegistryAddress.toLowerCase());
    expect(syncInputs.metadata.chainId).toBe(chainId);
    expect(syncInputs.metadata.blockNumber).toBe(proofBlockNumber);
    expect(syncInputs.metadata.stateRoot).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(syncInputs.metadata.publicCommitment).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(syncInputs.public_commitment.toLowerCase()).toBe(syncInputs.metadata.publicCommitment.toLowerCase());
    expect(syncInputs.metadata.nonce).toBe(defaultNonce);
    expect(syncInputs.credit_score).toBe(syncInputs.metadata.score);

    const requestResult = await postBackendJson<AxiomRequestResult>('/api/request-axiom-root', {
      userAddress: TARGET_USER_ADDRESS,
      blockNumber: syncInputs.metadata.blockNumber,
      chainId,
        rpcUrl: proofRpcUrl,
      creditPolicyAddress,
    });

    expect(requestResult.queryId).toMatch(/^\d+$/);
    expect(requestResult.blockNumber).toBe(syncInputs.metadata.blockNumber.toString());

    const relayer = await startAxiomRelayer({
      rpcUrl,
      chainId,
      axiomV2QueryAddress: requestResult.axiomV2QueryAddress,
      callbackTarget: requestResult.creditPolicyAddress,
      caller: requestResult.creditPolicyAddress,
      sourceChainId: chainId,
      stateRoot: syncInputs.metadata.stateRoot,
      extraData: encodeAbiParameters(parseAbiParameters('uint256'), [syncInputs.metadata.blockNumber]),
      signerPrivateKey: (process.env.AXIOM_QUERY_PRIVATE_KEY ?? process.env.AGENT_PRIVATE_KEY) as Hex,
      startBlock: syncInputs.metadata.blockNumber > 1n ? syncInputs.metadata.blockNumber - 1n : 0n,
    });

    try {
      const verifiedRoot = await waitForVerifiedRoot({
        rpcUrl,
        creditPolicyAddress: requestResult.creditPolicyAddress,
        blockNumber: syncInputs.metadata.blockNumber,
        expectedStateRoot: syncInputs.metadata.stateRoot,
      });

      expect(verifiedRoot.toLowerCase()).toBe(syncInputs.metadata.stateRoot.toLowerCase());

      const proofResult = await postBackendJson<GenerateLoanProofResult>('/api/generate-loan-proof', {
        userAddress: TARGET_USER_ADDRESS,
        blockNumber: syncInputs.metadata.blockNumber,
        nonce: defaultNonce,
        chainId,
        rpcUrl: proofRpcUrl,
        scoreRegistryAddress,
        creditPolicyAddress,
      });

      expect(proofResult.proof).toMatch(/^0x[0-9a-f]+$/i);
      expect(proofResult.publicInputs.length).toBeGreaterThan(0);
      expect(proofResult.publicInputs[0]?.toLowerCase()).toBe(syncInputs.metadata.publicCommitment.toLowerCase());
      expect(proofResult.stateRoot.toLowerCase()).toBe(syncInputs.metadata.stateRoot.toLowerCase());
      expect(proofResult.blockNumber).toBe(syncInputs.metadata.blockNumber.toString());
      expect(proofResult.creditPolicyAddress.toLowerCase()).toBe(requestResult.creditPolicyAddress.toLowerCase());
    } finally {
      relayer.stop();
      await relayer.done;
    }
  }, 900000);
});
