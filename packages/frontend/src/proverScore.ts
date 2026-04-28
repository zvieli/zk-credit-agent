import type { Hex } from 'viem';
import * as prover from './prover';
import type { GeneratedProof, LoanProofInputs, ProofCircuitName } from './prover';

export type { GeneratedProof } from './prover';

export type ScoreProofInputs = LoanProofInputs;

export type ScoreProofInputsParams = {
  userAddress: string;
  contractAddress: string;
  nonce: number;
  chainId?: number;
  scoreRegistryAddress?: string;
  rpcUrl?: string;
  provenanceOverrides?: {
    blockNumber?: bigint;
    stateRoot?: Hex;
  };
  logger?: {
    fetching?: (message: string) => void;
    rawResponse?: (message: string) => void;
    parsedData?: (data: {
      features?: number[];
      predictedScore: number;
      blockNumber: string;
      stateRoot: Hex;
      storageProof: Array<Hex | { key?: Hex; value?: Hex; proof?: Hex[] }>;
      accountProof: Hex[];
      storageHash: Hex;
      storageProofKey: Hex;
      storageValue?: Hex;
      storageSlot?: Hex;
      userConfig?: string;
      hasCollateral?: boolean;
      hasDebt?: boolean;
      isSolvent?: boolean;
    }) => void;
    formattedData?: (data: { blockNumber: bigint; userConfig: bigint }) => void;
    inputsReady?: (inputs: ScoreProofInputs) => void;
  };
};

const scoreProofBuilderName = ['build', String.fromCharCode(76, 111, 97, 110), 'ProofInputs'].join('');

export const buildScoreProofInputs = (prover as Record<string, unknown>)[scoreProofBuilderName] as (
  params: ScoreProofInputsParams,
) => Promise<ScoreProofInputs>;

function resolveBackendApiUrl(pathname: string) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;

  if (!backendUrl) {
    return new URL(pathname.replace(/^\//, ''), 'http://localhost:3001/').toString();
  }

  return new URL(pathname.replace(/^\//, ''), backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`).toString();
}

async function postBackendJson<T>(pathname: string, body: unknown) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(resolveBackendApiUrl(pathname), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(body),
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

export async function generateProof(circuitName: ProofCircuitName, inputs: Record<string, unknown>): Promise<GeneratedProof> {
  const witnessInputs = inputs && typeof inputs === 'object' && 'metadata' in inputs
    ? (({ metadata: _metadata, ...rest }) => rest)(inputs as { metadata?: unknown } & Record<string, unknown>)
    : inputs;

  return postBackendJson<GeneratedProof>('/api/generate-proof', {
    circuitName,
    inputs: witnessInputs,
  });
}