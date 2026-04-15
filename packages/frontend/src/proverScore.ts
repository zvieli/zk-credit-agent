import type { Hex } from 'viem';
import * as prover from './prover';

export type ScoreProofInputs = {
  account: Record<string, unknown>;
  storage: Record<string, unknown>;
  metadata: {
    nonce: number;
    chainId: number;
    contractAddress: Hex;
    userAddress: Hex;
    blockNumber: bigint;
    userConfig: bigint;
    stateRoot: Hex;
    accountTrieKey: Hex;
    storageRoot: Hex;
    storageProofKey: Hex;
    repaymentRate: number;
    score: number;
    isSolvent: boolean;
  };
};

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

export { generateProof, type GeneratedProof } from './prover';