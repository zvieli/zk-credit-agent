/// <reference path="./sdk-shims.d.ts" />

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import { createPublicClient, createWalletClient, hexToBytes, getAddress, http, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { Barretenberg, BackendType, UltraHonkBackend } from '@aztec/bb.js';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { getUserFeaturesAndSignature } from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Hex = `0x${string}`;
export type ProofCircuitName = 'account' | 'storage' | 'combined';

const DEFAULT_AAVE_POOL_ADDRESS = getAddress(process.env.AAVE_V3_POOL_ADDRESS ?? '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');

export type GeneratedProof = {
  proof: Hex;
  publicInputs: string[];
};

export type LoanProofInputs = {
  state_root: number[];
  public_commitment: Hex;
  account_nodes: number[][];
  account_lens: number[];
  account_node_types: number[];
  account_path_offsets: number[];
  account_path_lens: number[];
  account_value_offsets: number[];
  account_value_lens: number[];
  account_branch_indices: number[];
  account_balance_offset: number;
  account_balance_len: number;
  account_storage_root_offset: number;
  account_storage_root_len: number;
  account_steps: number;
  account_key: number[];
  storage_nodes: number[][];
  storage_lens: number[];
  storage_node_types: number[];
  storage_path_offsets: number[];
  storage_path_lens: number[];
  storage_value_offsets: number[];
  storage_value_lens: number[];
  storage_branch_indices: number[];
  storage_value_offset: number;
  storage_value_len: number;
  storage_steps: number;
  storage_key: number[];
  repayment_rate: number;
  is_solvent: boolean;
  credit_score: number;
  metadata: {
    nonce: number;
    chainId: number;
    contractAddress: Hex;
    userAddress: Hex;
    blockNumber: bigint;
    stateRoot: Hex;
    publicCommitment: Hex;
    accountTrieKey: Hex;
    storageRoot: Hex;
    storageProofKey: Hex;
    repaymentRate: number;
    score: number;
    isSolvent: boolean;
  };
};

type LoanProofParams = {
  userAddress: string;
  contractAddress: string;
  nonce: number;
  chainId?: number;
  rpcUrl?: string;
  scoreRegistryAddress?: string;
  provenanceOverrides?: {
    blockNumber?: bigint;
    stateRoot?: Hex;
  };
};

const circuitPaths: Record<ProofCircuitName, string> = {
  account: path.resolve(__dirname, '../../circuit/account/target/account_circuit.json'),
  storage: path.resolve(__dirname, '../../circuit/storage/target/storage_circuit.json'),
  combined: path.resolve(__dirname, '../../circuit/combined/target/combined.json'),
};

const circuitFallbackPaths: Record<ProofCircuitName, string> = {
  account: path.resolve(__dirname, '../../frontend/public/account_circuit.json'),
  storage: path.resolve(__dirname, '../../frontend/public/storage_circuit.json'),
  combined: path.resolve(__dirname, '../../frontend/public/combined_circuit.json'),
};

const circuitCache = new Map<ProofCircuitName, CompiledCircuit>();

function resolveEnvPath(envName: string, fallbackPath: string) {
  const envValue = process.env[envName];
  return envValue ? path.resolve(envValue) : fallbackPath;
}

export const COMBINED_CIRCUIT_DIR = path.resolve(__dirname, '../../circuit/combined');
export const COMBINED_CIRCUIT_JSON_PATH = path.resolve(COMBINED_CIRCUIT_DIR, 'target/combined.json');
export const COMBINED_GENERATED_VK_DIR = resolveEnvPath('COMBINED_GENERATED_VK_DIR', path.resolve(COMBINED_CIRCUIT_DIR, 'target/generated_vk'));
export const COMBINED_GENERATED_VK_PATH = path.resolve(COMBINED_GENERATED_VK_DIR, 'vk');
export const COMBINED_PROOF_OUTPUT_DIR = resolveEnvPath('COMBINED_PROOF_OUTPUT_DIR', path.resolve(COMBINED_CIRCUIT_DIR, 'out'));
export const COMBINED_PROOF_PATH = path.resolve(COMBINED_PROOF_OUTPUT_DIR, 'proof');
export const COMBINED_PUBLIC_INPUTS_PATH = path.resolve(COMBINED_PROOF_OUTPUT_DIR, 'public_inputs');

function buildTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => buildTomlValue(item)).join(', ')}]`;
  }

  if (typeof value === 'string') {
    return value.startsWith('0x') ? `"${value}"` : value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : '0';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (value === null || value === undefined) {
    return '[]';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

export function buildLoanProofToml(inputs: Record<string, unknown>) {
  return Object.entries(inputs)
    .map(([key, value]) => `${key} = ${buildTomlValue(value)}`)
    .join('\n');
}

export function writeLoanProofToml(outputPath: string, inputs: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildLoanProofToml(inputs), 'utf-8');
}

export function toLoanProofWitnessInputs(inputs: LoanProofInputs) {
  const { metadata: _metadata, ...witnessInputs } = inputs;
  return witnessInputs;
}

function loadVerifierArtifact(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function regenerateCombinedVerifierArtifacts() {
  console.log('Generating Solidity verifier sources...');
  execFileSync('npx', ['@aztec/bb.js@4.1.3', 'write_vk', '-t', 'evm', '-b', COMBINED_CIRCUIT_JSON_PATH, '-o', COMBINED_GENERATED_VK_DIR, '-s', 'ultra_honk'], {
    cwd: COMBINED_CIRCUIT_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  execFileSync('bb', ['write_solidity_verifier', '-t', 'evm', '-k', COMBINED_GENERATED_VK_PATH, '-o', '../../contracts/src/combined_verifier.sol', '-s', 'ultra_honk'], {
    cwd: COMBINED_CIRCUIT_DIR,
    stdio: 'inherit',
    env: process.env,
  });

  console.log('Building contract artifacts...');
  execSync('FOUNDRY_VIA_IR=false forge build -q', {
    cwd: path.resolve(__dirname, '../../contracts'),
    stdio: 'inherit',
    env: process.env,
  });
}

function readCompiledCircuit(circuitName: ProofCircuitName): CompiledCircuit {
  const cachedCircuit = circuitCache.get(circuitName);
  if (cachedCircuit) return cachedCircuit;

  const primaryCircuitPath = circuitPaths[circuitName];
  const circuitPath = fs.existsSync(primaryCircuitPath) ? primaryCircuitPath : circuitFallbackPaths[circuitName];
  const circuitJson = fs.readFileSync(circuitPath, 'utf8');
  const parsedCircuit = JSON.parse(circuitJson) as any;
  circuitCache.set(circuitName, parsedCircuit);
  return parsedCircuit;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}` as Hex;
}

function toFieldBuffer(value: bigint): Uint8Array {
  const buffer = Buffer.alloc(32);
  let remaining = value;

  for (let index = 31; index >= 0; index--) {
    buffer[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return buffer;
}

async function computePublicCommitment(stateRoot: Hex, isSolvent: boolean, score: number): Promise<Hex> {
  const bbModule = await import('@aztec/bb.js');
  const syncApi = await (bbModule as any).BarretenbergSync.initSingleton();
  const response = await syncApi.pedersenHash({
    inputs: [
      Buffer.from(hexToBytes(stateRoot)),
      toFieldBuffer(isSolvent ? 1n : 0n),
      toFieldBuffer(BigInt(score)),
    ],
    hashIndex: 0,
  });

  return bytesToHex(response.hash as Uint8Array);
}

function isZeroRoot(root: Hex | undefined | null) {
  return !root || root === '0x0000000000000000000000000000000000000000000000000000000000000000';
}

function resolveTrieRoot(primaryRoot: Hex | undefined | null, fallbackRoot?: Hex): Hex {
  const resolvedRoot = isZeroRoot(primaryRoot) ? fallbackRoot : primaryRoot;

  if (!resolvedRoot) {
    throw new Error('Unable to resolve trie root');
  }

  return resolvedRoot;
}

function flattenStorageProofNodes(storageProof: readonly unknown[]) {
  if (!Array.isArray(storageProof) || storageProof.length === 0) {
    return [] as string[];
  }

  const firstEntry = storageProof[0];
  if (typeof firstEntry === 'string') {
    return storageProof as string[];
  }

  if (firstEntry && typeof firstEntry === 'object' && Array.isArray((firstEntry as { proof?: unknown[] }).proof)) {
    return (firstEntry as { proof: string[] }).proof;
  }

  return [] as string[];
}

const STATIC_PATH_NODE_LIMIT = 9;
const STATIC_PATH_NODE_BYTES = 600;

function expandToNibbles(key: Uint8Array): number[] {
  const nibbles: number[] = [];

  for (const byte of key) {
    nibbles.push(byte >> 4);
    nibbles.push(byte & 0x0f);
  }

  return nibbles;
}

function encodeStaticPathNode(node: Uint8Array) {
  if (node.length > STATIC_PATH_NODE_BYTES) {
    throw new Error(`Static path node exceeds ${STATIC_PATH_NODE_BYTES} bytes`);
  }

  const encoded = new Array<number>(STATIC_PATH_NODE_BYTES).fill(0);
  for (let index = 0; index < node.length; index++) {
    encoded[index] = node[index]!;
  }

  return encoded;
}

function packStaticPathNodes(nodes: readonly Uint8Array[]): number[][] {
  if (nodes.length > STATIC_PATH_NODE_LIMIT) {
    throw new Error(`Static path proof exceeds ${STATIC_PATH_NODE_LIMIT} nodes`);
  }

  const packedNodes = nodes.map(encodeStaticPathNode);
  while (packedNodes.length < STATIC_PATH_NODE_LIMIT) {
    packedNodes.push(new Array<number>(STATIC_PATH_NODE_BYTES).fill(0));
  }

  return packedNodes;
}

function packStaticPathScalars(values: readonly number[]) {
  if (values.length > STATIC_PATH_NODE_LIMIT) {
    throw new Error(`Static path proof exceeds ${STATIC_PATH_NODE_LIMIT} steps`);
  }

  const packedValues = values.slice(0, STATIC_PATH_NODE_LIMIT);
  while (packedValues.length < STATIC_PATH_NODE_LIMIT) {
    packedValues.push(0);
  }

  return packedValues;
}

function itemPayloadInfo(data: Uint8Array, offset: number): DecodedRlpItem {
  return decodeRlpItem(data, offset);
}

type DecodedRlpItem = {
  kind: number;
  payloadOffset: number;
  payloadLen: number;
  totalLen: number;
};

function decodeRlpItem(data: Uint8Array, offset: number): DecodedRlpItem {
  const prefix = data[offset]!;
  const headerLen = rlpHeaderLength(prefix);

  if (prefix < 0x80) {
    return { kind: 0, payloadOffset: offset, payloadLen: 1, totalLen: 1 };
  }

  if (prefix <= 0xb7) {
    const payloadLen = prefix - 0x80;
    return { kind: 0, payloadOffset: offset + 1, payloadLen, totalLen: payloadLen + 1 };
  }

  if (prefix < 0xc0) {
    const lengthSize = prefix - 0xb7;
    let payloadLen = 0;
    for (let index = 0; index < lengthSize; index++) {
      payloadLen = payloadLen * 256 + data[offset + 1 + index]!;
    }
    return { kind: 0, payloadOffset: offset + headerLen, payloadLen, totalLen: payloadLen + headerLen };
  }

  if (prefix <= 0xf7) {
    const payloadLen = prefix - 0xc0;
    return { kind: 1, payloadOffset: offset + 1, payloadLen, totalLen: payloadLen + 1 };
  }

  const lengthSize = prefix - 0xf7;
  let payloadLen = 0;
  for (let index = 0; index < lengthSize; index++) {
    payloadLen = payloadLen * 256 + data[offset + 1 + index]!;
  }

  return { kind: 1, payloadOffset: offset + headerLen, payloadLen, totalLen: payloadLen + headerLen };
}

function rlpHeaderLength(prefix: number) {
  if (prefix < 0x80) {
    return 1;
  }

  if (prefix <= 0xb7) {
    return 1;
  }

  if (prefix < 0xc0) {
    return 1 + (prefix - 0xb7);
  }

  if (prefix <= 0xf7) {
    return 1;
  }

  return 1 + (prefix - 0xf7);
}

function listItemAt(data: Uint8Array, listPayloadOffset: number, targetIndex: number): [number, DecodedRlpItem] {
  let offset = listPayloadOffset;
  let item: DecodedRlpItem = { kind: 0, payloadOffset: listPayloadOffset, payloadLen: 0, totalLen: 0 };

  for (let index = 0; index <= targetIndex; index++) {
    item = decodeRlpItem(data, offset);
    offset += item.totalLen;
  }

  return [offset - item.totalLen, item];
}

function keyNibbleAt(key: Uint8Array, nibbleIndex: number) {
  const byte = key[Math.floor(nibbleIndex / 2)]!;
  return nibbleIndex % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

function verifyCompactPath(pathBytes: Uint8Array, pathOffset: number, pathLen: number, key: Uint8Array, keyOffset: number) {
  const first = pathBytes[pathOffset]!;
  const prefix = first >> 4;
  const isLeaf = prefix >= 2;
  const isOdd = prefix % 2 === 1;
  const expectedNibbles = isOdd ? pathLen * 2 - 1 : pathLen * 2 - 2;

  let consumed = isOdd ? 1 : 0;

  if (isOdd) {
    if ((first & 0x0f) !== keyNibbleAt(key, keyOffset)) {
      throw new Error('compact path nibble mismatch');
    }
  } else if ((first & 0x0f) !== 0) {
    throw new Error('compact path padding mismatch');
  }

  for (let index = 1; index < 33; index++) {
    if (index < pathLen) {
      const byte = pathBytes[pathOffset + index]!;
      const hi = byte >> 4;
      const lo = byte & 0x0f;

      if (consumed < expectedNibbles) {
        if (hi !== keyNibbleAt(key, keyOffset + consumed)) {
          throw new Error('compact path nibble mismatch');
        }
        consumed += 1;
      }

      if (consumed < expectedNibbles) {
        if (lo !== keyNibbleAt(key, keyOffset + consumed)) {
          throw new Error('compact path nibble mismatch');
        }
        consumed += 1;
      }
    }
  }

  if (consumed !== expectedNibbles) {
    throw new Error('compact path length mismatch');
  }

  return { isLeaf, consumed };
}

function compactPathToNibbles(pathBytes: Uint8Array, pathOffset: number, pathLen: number) {
  const nibbles: number[] = [];

  if (pathLen === 0) {
    return nibbles;
  }

  const first = pathBytes[pathOffset]!;
  const isOdd = (first >> 4) % 2 === 1;

  if (isOdd) {
    nibbles.push(first & 0x0f);
  }

  for (let index = 1; index < pathLen; index++) {
    const byte = pathBytes[pathOffset + index]!;
    nibbles.push(byte >> 4, byte & 0x0f);
  }

  return nibbles;
}

function describeStaticPathProof(nodesHex: readonly string[], rootHash: Hex, key: Uint8Array): {
  ordered: Uint8Array[];
  childOffsets: number[];
  childLens: number[];
  pathOffsets: number[];
  pathLens: number[];
  branchIndices: number[];
  nodeLens: number[];
  nodeTypes: number[];
  trieKey: Uint8Array;
  leafValue: Uint8Array;
} {
  try {
    const remaining = nodesHex.map((nodeHex) => hexToBytes(nodeHex as Hex));
    const ordered: Uint8Array[] = [];
    const childOffsets: number[] = [];
    const childLens: number[] = [];
    const pathOffsets: number[] = [];
    const pathLens: number[] = [];
    const branchIndices: number[] = [];
    const nodeLens: number[] = [];
    const nodeTypes: number[] = [];
    const pathNibbles: number[] = [];
    let keyOffset = 0;
    const rootIndex = remaining.findIndex((node) => keccak256(node) === rootHash);

    if (rootIndex < 0) {
      throw new Error(`Root node not found for ${rootHash}`);
    }

    let currentNode = remaining.splice(rootIndex, 1)[0]!;

    for (let step = 0; step < STATIC_PATH_NODE_LIMIT; step++) {
      ordered.push(currentNode);
      nodeLens.push(currentNode.length);

      const decodedNode = decodeRlpItem(currentNode, 0);
      const [firstItemOffset, firstItem] = listItemAt(currentNode, decodedNode.payloadOffset, 0);
      const [secondItemOffset, secondItem] = listItemAt(currentNode, decodedNode.payloadOffset, 1);
      const isCompactNode = secondItemOffset + secondItem.totalLen === decodedNode.totalLen;

      if (isCompactNode) {
        nodeTypes.push(1);
        pathOffsets.push(firstItem.payloadOffset);
        pathLens.push(firstItem.payloadLen);
        branchIndices.push(0);

        const { isLeaf, consumed } = verifyCompactPath(currentNode, firstItem.payloadOffset, firstItem.payloadLen, key, keyOffset);
        const compactNibbles = compactPathToNibbles(currentNode, firstItem.payloadOffset, firstItem.payloadLen);
        pathNibbles.push(...compactNibbles);
        keyOffset += consumed;

        childOffsets.push(secondItem.payloadOffset);
        childLens.push(secondItem.payloadLen);

        if (isLeaf) {
          return {
            ordered,
            childOffsets,
            childLens,
            pathOffsets,
            pathLens,
            branchIndices,
            nodeLens,
            nodeTypes,
            trieKey: safeTrieKeyFromNibbles(pathNibbles),
            leafValue: currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen),
          };
        }

        const reference = currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
        const nextIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));

        if (nextIndex < 0) {
          if (reference.length > 0 && reference.length < 32) {
            console.info('[sync] inline extension child fallback', { referenceLen: reference.length });
            currentNode = reference;
            continue;
          }

          throw new Error('Unable to resolve extension child in static path proof');
        }

        currentNode = remaining.splice(nextIndex, 1)[0]!;
        continue;
      }

      nodeTypes.push(0);
      pathOffsets.push(0);
      pathLens.push(0);

      if (keyOffset === 64) {
        const [terminalItemOffset, terminalItem] = listItemAt(currentNode, decodedNode.payloadOffset, 16);
        childOffsets.push(terminalItem.payloadOffset);
        childLens.push(terminalItem.payloadLen);
        branchIndices.push(16);

        if (terminalItem.payloadLen === 0) {
          throw new Error('Terminal branch node is missing its value item');
        }

        return {
          ordered,
          childOffsets,
          childLens,
          pathOffsets,
          pathLens,
          branchIndices,
          nodeLens,
          nodeTypes,
          trieKey: safeTrieKeyFromNibbles(pathNibbles),
          leafValue: currentNode.slice(terminalItem.payloadOffset, terminalItem.payloadOffset + terminalItem.payloadLen),
        };
      }

      const branchIndex = keyNibbleAt(key, keyOffset);
      const [candidateOffset, candidateChild] = listItemAt(currentNode, decodedNode.payloadOffset, branchIndex);

      if (candidateChild.payloadLen === 0) {
        throw new Error('Unable to resolve branch child in static path proof');
      }

      const reference = currentNode.slice(candidateChild.payloadOffset, candidateChild.payloadOffset + candidateChild.payloadLen);
      const nextIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));

      childOffsets.push(candidateChild.payloadOffset);
      childLens.push(candidateChild.payloadLen);
      branchIndices.push(branchIndex);

      if (nextIndex < 0) {
        if (reference.length > 0 && reference.length < 32) {
          console.info('[sync] inline branch child fallback', { referenceLen: reference.length });
          pathNibbles.push(branchIndex);
          keyOffset += 1;
          currentNode = reference;
          continue;
        }

        throw new Error('Unable to resolve branch child in static path proof');
      }

      pathNibbles.push(branchIndex);
      keyOffset += 1;
      currentNode = remaining.splice(nextIndex, 1)[0]!;
    }

    throw new Error(`Static path proof exceeds ${STATIC_PATH_NODE_LIMIT} steps`);
  } catch (error) {
    console.info('[sync] keyless static path fallback', { reason: error instanceof Error ? error.message : String(error) });
    const fallback = orderProofNodesKeyless(nodesHex, rootHash);
    return {
      ordered: fallback.ordered,
      childOffsets: [],
      childLens: [],
      pathOffsets: [],
      pathLens: [],
      branchIndices: [],
      nodeLens: fallback.ordered.map((node) => node.length),
      nodeTypes: [],
      trieKey: new Uint8Array(),
      leafValue: fallback.leafValue,
    };
  }
}

function nibblesToBytes(nibbles: number[]) {
  if (nibbles.length % 2 !== 0) {
    throw new Error(`Trie key nibble count must be even, got ${nibbles.length}`);
  }

  const bytes = new Uint8Array(nibbles.length / 2);
  for (let index = 0; index < nibbles.length; index += 2) {
    bytes[index / 2] = (nibbles[index]! << 4) | nibbles[index + 1]!;
  }

  return bytes;
}

function safeTrieKeyFromNibbles(nibbles: number[]) {
  return nibbles.length % 2 === 0 ? nibblesToBytes(nibbles) : new Uint8Array();
}

function nodeMatchesReference(node: Uint8Array, reference: Uint8Array) {
  if (node.length === reference.length) {
    let matches = true;
    for (let index = 0; index < node.length; index++) {
      if (node[index] !== reference[index]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return keccak256(node) === bytesToHex(reference);
}

function nodeReferencesCandidate(node: Uint8Array, candidate: Uint8Array) {
  try {
    const decodedNode = decodeRlpItem(node, 0);
    const [, firstItem] = listItemAt(node, decodedNode.payloadOffset, 0);
    const [secondItemOffset, secondItem] = listItemAt(node, decodedNode.payloadOffset, 1);
    const isCompactNode = secondItemOffset + secondItem.totalLen === decodedNode.totalLen;

    if (isCompactNode) {
      if (secondItem.payloadLen === 0) {
        return false;
      }

      const reference = node.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      return nodeMatchesReference(candidate, reference);
    }

    for (let index = 0; index < 16; index++) {
      const [, childItem] = listItemAt(node, decodedNode.payloadOffset, index);

      if (childItem.payloadLen === 0) {
        continue;
      }

      const reference = node.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
      if (nodeMatchesReference(candidate, reference)) {
        return true;
      }
    }

    void firstItem;
    return false;
  } catch {
    return false;
  }
}

function findRootNodeIndex(nodes: Uint8Array[], rootHash: Hex) {
  const explicitIndex = nodes.findIndex((node) => keccak256(node) === rootHash);

  if (explicitIndex >= 0) {
    return explicitIndex;
  }

  for (let candidateIndex = 0; candidateIndex < nodes.length; candidateIndex++) {
    const candidate = nodes[candidateIndex]!;
    let referenced = false;

    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      if (nodeIndex === candidateIndex) {
        continue;
      }

      if (nodeReferencesCandidate(nodes[nodeIndex]!, candidate)) {
        referenced = true;
        break;
      }
    }

    if (!referenced) {
      return candidateIndex;
    }
  }

  return nodes.length > 0 ? 0 : -1;
}

function orderProofNodesKeyless(nodesHex: readonly (string | Uint8Array)[], rootHash: Hex) {
  const remaining = nodesHex.map((node) => (typeof node === 'string' ? hexToBytes(node as Hex) : node));
  const ordered: Uint8Array[] = [];
  const pathNibbles: number[] = [];
  const rootIndex = findRootNodeIndex(remaining, rootHash);

  if (rootIndex < 0) {
    throw new Error(`Root node not found for ${rootHash}`);
  }

  let currentNode = remaining.splice(rootIndex, 1)[0]!;

  for (let step = 0; step < 32; step++) {
    ordered.push(currentNode);
    const node = decodeRlpItem(currentNode, 0);
    const [firstItemOffset, firstItem] = listItemAt(currentNode, node.payloadOffset, 0);
    const [secondItemOffset, secondItem] = listItemAt(currentNode, node.payloadOffset, 1);

    if (secondItemOffset + secondItem.totalLen === node.totalLen) {
      const compactNibbles = compactPathToNibbles(currentNode, firstItem.payloadOffset, firstItem.payloadLen);
      pathNibbles.push(...compactNibbles);
      const prefix = currentNode[firstItem.payloadOffset]! >> 4;
      const isLeaf = prefix >= 2;
      if (isLeaf) {
        return {
          ordered: [...ordered, ...remaining],
          leafValue: currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen),
        };
      }

      const reference = currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      const nextIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));

      if (nextIndex < 0) {
        if (reference.length < 32 && reference.length > 0) {
          currentNode = reference;
          continue;
        }

        return { ordered: [...ordered, ...remaining], leafValue: new Uint8Array() };
      }

      currentNode = remaining.splice(nextIndex, 1)[0]!;
    } else {
      let nextIndex = -1;
      let branchIndex = -1;

      for (let index = 0; index < 16; index++) {
        const [childItemOffset, childItem] = listItemAt(currentNode, node.payloadOffset, index);
        if (childItem.payloadLen === 0) {
          continue;
        }

        const reference = currentNode.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
        const candidateIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));
        if (candidateIndex >= 0) {
          nextIndex = candidateIndex;
          branchIndex = index;
          break;
        }
      }

      if (nextIndex < 0) {
        return { ordered: [...ordered, ...remaining], leafValue: new Uint8Array() };
      }

      pathNibbles.push(branchIndex);
      currentNode = remaining.splice(nextIndex, 1)[0]!;
    }
  }

  return { ordered: [...ordered, ...remaining], leafValue: new Uint8Array() };
}

// Helper for key selection
function keyNibble_at(key: Uint8Array, nibbleIndex: number) {
  const byte = key[Math.floor(nibbleIndex / 2)]!;
  return nibbleIndex % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

function inferProofRootHash(nodesHex: readonly (string | Uint8Array)[]) {
  const nodes = nodesHex.map((node) => (typeof node === 'string' ? hexToBytes(node as Hex) : node));
  const nodeHashes = nodes.map((node) => keccak256(node));
  const incomingCounts = new Map<string, number>(nodeHashes.map((hash) => [hash, 0]));

  for (const node of nodes) {
    const decodedNode = decodeRlpItem(node, 0);
    const [firstItemOffset, firstItem] = listItemAt(node, decodedNode.payloadOffset, 0);
    const [secondItemOffset, secondItem] = listItemAt(node, decodedNode.payloadOffset, 1);

    if (secondItemOffset + secondItem.totalLen === decodedNode.totalLen) {
      if (secondItem.payloadLen > 0) {
        const reference = node.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
        const matchedNode = nodes.find((candidate) => bytesToHex(candidate) === bytesToHex(reference) || keccak256(candidate) === bytesToHex(reference));
        if (matchedNode) {
          const matchedHash = keccak256(matchedNode);
          incomingCounts.set(matchedHash, (incomingCounts.get(matchedHash) ?? 0) + 1);
        }
      }
    } else {
      for (let index = 0; index < 16; index++) {
        const [childItemOffset, childItem] = listItemAt(node, decodedNode.payloadOffset, index);
        if (childItem.payloadLen === 0) {
          continue;
        }

        const reference = node.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
        const matchedNode = nodes.find((candidate) => bytesToHex(candidate) === bytesToHex(reference) || keccak256(candidate) === bytesToHex(reference));
        if (matchedNode) {
          const matchedHash = keccak256(matchedNode);
          incomingCounts.set(matchedHash, (incomingCounts.get(matchedHash) ?? 0) + 1);
        }
      }
    }
  }

  for (let index = 0; index < nodes.length; index++) {
    const nodeHash = nodeHashes[index]!;
    if ((incomingCounts.get(nodeHash) ?? 0) === 0) {
      return nodeHash as Hex;
    }
  }

  return undefined;
}

function extractAccountLeafFieldHints(leafValue: Uint8Array) {
  const leafNode = decodeRlpItem(leafValue, 0);
  const [, leafValueItem] = listItemAt(leafValue, leafNode.payloadOffset, 1);
  const accountRecord = decodeRlpItem(leafValue, leafValueItem.payloadOffset);
  const [, balanceItem] = listItemAt(leafValue, accountRecord.payloadOffset, 1);
  const [, storageRootItem] = listItemAt(leafValue, accountRecord.payloadOffset, 2);

  if (storageRootItem.payloadLen !== 32) {
    throw new Error(`Unexpected account leaf storage root length: ${storageRootItem.payloadLen}`);
  }

  return {
    balanceOffset: balanceItem.payloadOffset,
    balanceLen: balanceItem.payloadLen,
    storageRootOffset: storageRootItem.payloadOffset,
    storageRootLen: storageRootItem.payloadLen,
    storageRoot: leafValue.slice(storageRootItem.payloadOffset, storageRootItem.payloadOffset + storageRootItem.payloadLen),
  };
}

export async function buildLoanProofInputs(params: LoanProofParams): Promise<LoanProofInputs> {
  const chainId = params.chainId ?? 1;
  const validatedUserAddress = getAddress(params.userAddress);
  const validatedContractAddress = getAddress(params.contractAddress);

  const { blockNumber, stateRoot, storageProof, accountProof, storageHash, storageProofKey, predictedScore, isSolvent, storageSlot } = await getUserFeaturesAndSignature(
    validatedUserAddress,
    validatedContractAddress,
    chainId,
    params.nonce,
    params.rpcUrl,
    params.provenanceOverrides
  );
  const flattenedStorageProof = flattenStorageProofNodes(storageProof as readonly unknown[]);
  
  const recoveredStateRoot = inferProofRootHash(accountProof);
  const inferredStateRoot = resolveTrieRoot(stateRoot as Hex | undefined, recoveredStateRoot);
  // Account proof must match the Aave pool account proven by the backend.
  const accountTrieKeyBytes = hexToBytes(keccak256(hexToBytes(DEFAULT_AAVE_POOL_ADDRESS)));
  const accountTrieKeyHex = bytesToHex(accountTrieKeyBytes) as Hex;
  const accountTrieKeyNibbles = expandToNibbles(accountTrieKeyBytes);
  const accountPath = describeStaticPathProof(accountProof, inferredStateRoot, accountTrieKeyBytes);
  const accountNodes = packStaticPathNodes(accountPath.ordered);
  const accountNodeLens = packStaticPathScalars(accountPath.nodeLens).map((value) => Number(value));
  const accountNodeTypes = packStaticPathScalars(accountPath.nodeTypes).map((value) => Number(value));
  const accountPathOffsets = packStaticPathScalars(accountPath.pathOffsets).map((value) => Number(value));
  const accountPathLens = packStaticPathScalars(accountPath.pathLens).map((value) => Number(value));
  const accountValueOffsets = packStaticPathScalars(accountPath.childOffsets).map((value) => Number(value));
  const accountValueLens = packStaticPathScalars(accountPath.childLens).map((value) => Number(value));
  const accountBranchIndices = packStaticPathScalars(accountPath.branchIndices).map((value) => Number(value));
  const accountRealSteps = Number(accountPath.ordered.length);
  let accountLeafStorageRoot: Hex | undefined;
  let accountBalanceOffset = 0;
  let accountBalanceLen = 0;
  let accountStorageRootOffset = 0;
  let accountStorageRootLen = 0;

  try {
    const accountLeaf = accountPath.ordered[accountPath.ordered.length - 1]!;
    const accountLeafFields = extractAccountLeafFieldHints(accountLeaf);
    accountBalanceOffset = accountLeafFields.balanceOffset;
    accountBalanceLen = accountLeafFields.balanceLen;
    accountStorageRootOffset = accountLeafFields.storageRootOffset;
    accountStorageRootLen = accountLeafFields.storageRootLen;
    accountLeafStorageRoot = bytesToHex(accountLeafFields.storageRoot) as Hex;
  } catch (error) {
    console.info('[sync] account leaf storage root fallback', { reason: error instanceof Error ? error.message : String(error) });
  }

  const storageProofKeyHex = storageProofKey as Hex;
  const recoveredStorageRoot = inferProofRootHash(flattenedStorageProof);
  const resolvedStorageRoot = resolveTrieRoot(accountLeafStorageRoot, recoveredStorageRoot ?? (storageHash as Hex));
  const storageTrieKeyHex = keccak256(hexToBytes(storageProofKeyHex));
  const storageKeyBytes = hexToBytes(storageTrieKeyHex);
  const storagePath = describeStaticPathProof(flattenedStorageProof, resolvedStorageRoot, storageKeyBytes);
  const storageNodes = packStaticPathNodes(storagePath.ordered);
  const storageNodeLens = packStaticPathScalars(storagePath.nodeLens).map((value) => Number(value));
  const storageNodeTypes = packStaticPathScalars(storagePath.nodeTypes).map((value) => Number(value));
  const storagePathOffsets = packStaticPathScalars(storagePath.pathOffsets).map((value) => Number(value));
  const storagePathLens = packStaticPathScalars(storagePath.pathLens).map((value) => Number(value));
  const storageValueOffsets = packStaticPathScalars(storagePath.childOffsets).map((value) => Number(value));
  const storageValueLens = packStaticPathScalars(storagePath.childLens).map((value) => Number(value));
  const storageBranchIndices = packStaticPathScalars(storagePath.branchIndices).map((value) => Number(value));
  const storageValueOffset = Number(storagePath.childOffsets[storagePath.childOffsets.length - 1] ?? 0);
  const storageValueLen = Number(storagePath.childLens[storagePath.childLens.length - 1] ?? 0);
  const storageRealSteps = Number(storagePath.ordered.length);

  const storageLeaf = storagePath.ordered[storagePath.ordered.length - 1] ?? new Uint8Array();
  const storageWord = new Uint8Array(32);

  const bitAtWord = (word: Uint8Array, bitIndex: number) => {
    const byteIndex = 31 - Math.floor(bitIndex / 8);
    const bitIndexInByte = bitIndex % 8;
    return ((word[byteIndex] ?? 0) >> bitIndexInByte) & 1;
  };

  const computeSolventFromWord = (word: Uint8Array) => {
    let hasCollateral = false;
    let hasDebt = false;

    for (let index = 0; index < 128; index++) {
      if (bitAtWord(word, index * 2 + 1) === 1) {
        hasCollateral = true;
      }
      if (bitAtWord(word, index * 2) === 1) {
        hasDebt = true;
      }
    }

    return hasCollateral && !hasDebt;
  };

  if (storageValueLen !== 0) {
    const start = 32 - storageValueLen;

    for (let index = 0; index < 32; index++) {
      if (index >= start) {
        storageWord[index] = storageLeaf[storageValueOffset + index - start] ?? 0;
      }
    }
  }

  const proofIsSolvent = computeSolventFromWord(storageWord);
  const publicCommitment = await computePublicCommitment(inferredStateRoot, proofIsSolvent, predictedScore);

  const repaymentRate = Number(predictedScore) * 10_000;

  return {
    state_root: Array.from(hexToBytes(inferredStateRoot)),
    public_commitment: publicCommitment,
    account_nodes: accountNodes,
    account_lens: accountNodeLens,
    account_node_types: accountNodeTypes,
    account_path_offsets: accountPathOffsets,
    account_path_lens: accountPathLens,
    account_value_offsets: accountValueOffsets,
    account_value_lens: accountValueLens,
    account_branch_indices: accountBranchIndices,
    account_balance_offset: accountBalanceOffset,
    account_balance_len: accountBalanceLen,
    account_storage_root_offset: accountStorageRootOffset,
    account_storage_root_len: accountStorageRootLen,
    account_steps: accountRealSteps,
    account_key: accountTrieKeyNibbles,
    storage_nodes: storageNodes,
    storage_lens: storageNodeLens,
    storage_node_types: storageNodeTypes,
    storage_path_offsets: storagePathOffsets,
    storage_path_lens: storagePathLens,
    storage_value_offsets: storageValueOffsets,
    storage_value_lens: storageValueLens,
    storage_branch_indices: storageBranchIndices,
    storage_value_offset: storageValueOffset,
    storage_value_len: storageValueLen,
    storage_steps: storageRealSteps,
    storage_key: expandToNibbles(storageKeyBytes),
    repayment_rate: repaymentRate,
    is_solvent: proofIsSolvent,
    credit_score: predictedScore,
    metadata: {
      nonce: params.nonce,
      chainId,
      contractAddress: validatedContractAddress as Hex,
      userAddress: validatedUserAddress as Hex,
      blockNumber,
      stateRoot: inferredStateRoot,
      publicCommitment,
      accountTrieKey: accountTrieKeyHex,
      storageRoot: resolvedStorageRoot,
      storageProofKey: storageProofKeyHex,
      repaymentRate,
      score: predictedScore,
      isSolvent: proofIsSolvent,
    },
  };
}

export async function generateProof(circuitName: ProofCircuitName, inputs: Record<string, unknown>): Promise<GeneratedProof> {
  const circuit = readCompiledCircuit(circuitName);
  const barretenbergThreads = Number(process.env.BB_THREADS ?? '8');
  let api: Barretenberg | undefined;

  try {
    const witnessInputs = (inputs && typeof inputs === 'object' && 'metadata' in inputs)
      ? (() => {
          const { metadata: _metadata, ...rest } = inputs as { metadata?: unknown } & Record<string, unknown>;
          return rest;
        })()
      : inputs;

    if (circuitName === 'combined') {
      console.log(`[proof:${circuitName}] generating witness via nargo`);
      execFileSync('nargo', ['execute', 'witness', '-p', 'Prover'], {
        cwd: COMBINED_CIRCUIT_DIR,
        stdio: 'inherit',
        env: process.env,
      });

      console.log(`[proof:${circuitName}] generating proof via bb cli`);
      fs.mkdirSync(COMBINED_PROOF_OUTPUT_DIR, { recursive: true });
      execFileSync('bb', ['prove', '--slow_low_memory', '--storage_budget', '500m', '-k', COMBINED_GENERATED_VK_PATH, '-b', COMBINED_CIRCUIT_JSON_PATH, '-w', './target/witness.gz', '-t', 'evm', '-o', COMBINED_PROOF_OUTPUT_DIR, '-s', 'ultra_honk'], {
        cwd: COMBINED_CIRCUIT_DIR,
        stdio: 'inherit',
        env: process.env,
      });

      const proof = fs.readFileSync(COMBINED_PROOF_PATH);
      const publicInputs = [bytesToHex(fs.readFileSync(COMBINED_PUBLIC_INPUTS_PATH))];

      console.log(`[proof:${circuitName}] proof generated`);
      return { proof: bytesToHex(proof), publicInputs };
    }

    const noir = new Noir(circuit);

    console.log(`[proof:${circuitName}] initializing noir`);
    await noir.init();
    console.log(`[proof:${circuitName}] executing witness`);

    const { witness } = await noir.execute(witnessInputs as any);

    console.log(`[proof:${circuitName}] generating proof with bb api`);
    api = await Barretenberg.new({
      backend: BackendType.NativeSharedMemory,
      threads: barretenbergThreads,
    });
    const backend = new UltraHonkBackend(circuit.bytecode, api);
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'evm' });

    console.log(`[proof:${circuitName}] proof generated`);
    return { proof: bytesToHex(proof), publicInputs };
  } catch (error) {
    console.error(`Proof generation failed for ${circuitName} circuit`);
    throw error;
  } finally {
    if (api) {
      await api.destroy();
    }
  }
}

async function runLoanProofCli() {
  const borrowerAddress = process.argv[2] ?? process.env.ADDR;

  if (!borrowerAddress) {
    throw new Error('Missing borrower address. Pass ADDR or a positional address argument.');
  }

  const privateKey = (process.env.AGENT_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as Hex;
  const account = privateKeyToAccount(privateKey);
  const rpcUrl = process.env.RPC_URL || process.env.PROOF_RPC_URL || 'http://127.0.0.1:8545';
  const chainId = process.env.CIRCUIT_CHAIN_ID ? Number(process.env.CIRCUIT_CHAIN_ID) : 1;
  const nonce = process.env.CIRCUIT_NONCE ? Number(process.env.CIRCUIT_NONCE) : Math.floor(Date.now() / 1000) >>> 0;
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  process.env.PROOF_RPC_URL = rpcUrl;

  const walletClient = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  await publicClient.request({
    method: 'anvil_setBalance',
    params: [account.address, '0x100000000000000000000'],
  } as any);

  const contractsRoot = path.resolve(__dirname, '../../contracts');
  const scoreRegistryArtifactPath = path.resolve(contractsRoot, 'out/ScoreRegistry.sol/ScoreRegistry.json');
  const scoreRegistryArtifact = loadVerifierArtifact(scoreRegistryArtifactPath);

  const deployedScoreRegistryHash = await walletClient.deployContract({
    abi: scoreRegistryArtifact.abi,
    bytecode: scoreRegistryArtifact.bytecode.object as `0x${string}`,
  });
  const deployedScoreRegistryReceipt = await publicClient.waitForTransactionReceipt({ hash: deployedScoreRegistryHash });
  const scoreRegistryAddress = deployedScoreRegistryReceipt.contractAddress!;

  const provisionalScoreData = await getUserFeaturesAndSignature(borrowerAddress, scoreRegistryAddress, chainId, nonce);
  const provisionalScore = provisionalScoreData.predictedScore;
  const provisionalRepaymentRate = provisionalScore * 10_000;

  const setScoreHash = await walletClient.writeContract({
    address: scoreRegistryAddress,
    abi: scoreRegistryArtifact.abi,
    functionName: 'setScore',
    args: [borrowerAddress, provisionalRepaymentRate],
  });
  await publicClient.waitForTransactionReceipt({ hash: setScoreHash });

  const proofInputs = await buildLoanProofInputs({
    userAddress: borrowerAddress,
    contractAddress: scoreRegistryAddress,
    nonce,
    chainId,
    scoreRegistryAddress,
  });

  const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const combinedTomlPath = path.resolve(workspaceRoot, 'packages/circuit/combined/Prover.toml');
  writeLoanProofToml(combinedTomlPath, toLoanProofWitnessInputs(proofInputs));

  console.log(`Wrote ${combinedTomlPath}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runLoanProofCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}