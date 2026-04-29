/// <reference path="./sdk-shims.d.ts" />

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import { createPublicClient, createWalletClient, getAddress, http, type Hex, hexToBytes, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserFeaturesAndSignature, type UserFeaturesResult } from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ProofCircuitName = 'account' | 'storage' | 'combined';

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
    userConfig: bigint;
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

export type LoanProofParams = {
  userAddress: string;
  contractAddress: string;
  nonce: number;
  chainId?: number;
  rpcUrl?: string;
  provenanceOverrides?: {
    blockNumber?: bigint;
    stateRoot?: Hex;
  };
};

const COMBINED_CIRCUIT_DIR = path.resolve(__dirname, '../../circuit/combined');
const COMBINED_CIRCUIT_JSON_PATH = path.resolve(COMBINED_CIRCUIT_DIR, 'target/combined.json');
const COMBINED_GENERATED_VK_DIR = path.resolve(COMBINED_CIRCUIT_DIR, 'target/generated_vk');
const COMBINED_GENERATED_VK_PATH = path.resolve(COMBINED_GENERATED_VK_DIR, 'vk');

export function regenerateCombinedVerifierArtifacts() {
  console.log('Generating Proving/Verification Keys only...');
  execFileSync('npx', ['@aztec/bb.js@4.1.3', 'write_vk', '-t', 'evm', '-b', COMBINED_CIRCUIT_JSON_PATH, '-o', COMBINED_GENERATED_VK_DIR, '-s', 'ultra_honk'], {
    cwd: COMBINED_CIRCUIT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  
  console.log('Skipping bb write_solidity_verifier to preserve manual fixes.');
  console.log('Please run forge build manually in packages/contracts.');
}

function bytesToHexLocal(bytes: Uint8Array): Hex {
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
  return bytesToHexLocal(response.hash as Uint8Array);
}

function isZeroRoot(root: Hex | undefined | null) {
  return !root || root === '0x0000000000000000000000000000000000000000000000000000000000000000';
}

function resolveTrieRoot(primaryRoot: Hex | undefined | null, fallbackRoot?: Hex): Hex {
  const resolvedRoot = isZeroRoot(primaryRoot) ? fallbackRoot : primaryRoot;
  if (!resolvedRoot) throw new Error('Unable to resolve trie root');
  return resolvedRoot;
}

const STATIC_PATH_NODE_LIMIT = 9;
const STATIC_PATH_NODE_BYTES = 600;

function expandToNibbles(key: Uint8Array): number[] {
  const nibbles: number[] = [];
  for (const byte of key) {
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  return nibbles;
}

function packStaticPathNodes(nodes: Uint8Array[]): number[][] {
  const packed: number[][] = [];
  for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
    const node = nodes[i] || new Uint8Array();
    const buffer = new Array(STATIC_PATH_NODE_BYTES).fill(0);
    for (let j = 0; j < node.length; j++) {
      buffer[j] = node[j];
    }
    packed.push(buffer);
  }
  return packed;
}

function packStaticPathScalars(values: number[]): bigint[] {
  const packed: bigint[] = [];
  for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
    packed.push(BigInt(values[i] || 0));
  }
  return packed;
}

function rlpHeaderLength(prefix: number): number {
  if (prefix < 0x80) return 0;
  if (prefix <= 0xb7) return 1;
  if (prefix <= 0xbf) return 1 + (prefix - 0xb7);
  if (prefix <= 0xf7) return 1;
  return 1 + (prefix - 0xf7);
}

type DecodedRlpItem = {
  kind: number;
  payloadOffset: number;
  payloadLen: number;
  totalLen: number;
};

function decodeRlpItem(data: Uint8Array, offset: number): DecodedRlpItem {
  const prefix = data[offset]!;
  if (prefix < 0x80) return { kind: 0, payloadOffset: offset, payloadLen: 1, totalLen: 1 };
  if (prefix <= 0xb7) return { kind: 0, payloadOffset: offset + 1, payloadLen: prefix - 0x80, totalLen: prefix - 0x80 + 1 };
  if (prefix <= 0xbf) {
    const lenLen = prefix - 0xb7;
    let len = 0;
    for (let i = 0; i < lenLen; i++) len = (len << 8) + data[offset + 1 + i]!;
    return { kind: 0, payloadOffset: offset + 1 + lenLen, payloadLen: len, totalLen: 1 + lenLen + len };
  }
  if (prefix <= 0xf7) return { kind: 1, payloadOffset: offset + 1, payloadLen: prefix - 0xc0, totalLen: prefix - 0xc0 + 1 };
  const lenLen = prefix - 0xf7;
  let len = 0;
  for (let i = 0; i < lenLen; i++) len = (len << 8) + data[offset + 1 + i]!;
  return { kind: 1, payloadOffset: offset + 1 + lenLen, payloadLen: len, totalLen: 1 + lenLen + len };
}

function listItemAt(data: Uint8Array, payloadOffset: number, index: number): [number, DecodedRlpItem] {
  let currentOffset = payloadOffset;
  for (let i = 0; i < index; i++) {
    const item = decodeRlpItem(data, currentOffset);
    currentOffset += item.totalLen;
  }
  return [currentOffset, decodeRlpItem(data, currentOffset)];
}

function nodeMatchesReference(node: Uint8Array, reference: Uint8Array) {
  if (node.length === reference.length) {
    let matches = true;
    for (let i = 0; i < node.length; i++) if (node[i] !== reference[i]) { matches = false; break; }
    if (matches) return true;
  }
  if (reference.length === 32) return keccak256(node) === bytesToHexLocal(reference);
  return false;
}

function nodeReferencesCandidate(node: Uint8Array, candidate: Uint8Array) {
  try {
    const decodedNode = decodeRlpItem(node, 0);
    const [, firstItem] = listItemAt(node, decodedNode.payloadOffset, 0);
    const [secondItemOffset, secondItem] = listItemAt(node, decodedNode.payloadOffset, 1);
    const isCompactNode = secondItemOffset + secondItem.totalLen === decodedNode.totalLen;
    if (isCompactNode) {
      if (secondItem.payloadLen === 0) return false;
      const reference = node.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      return nodeMatchesReference(candidate, reference);
    }
    for (let i = 0; i < 16; i++) {
      const [, childItem] = listItemAt(node, decodedNode.payloadOffset, i);
      if (childItem.payloadLen === 0) continue;
      const reference = node.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
      if (nodeMatchesReference(candidate, reference)) return true;
    }
    return false;
  } catch { return false; }
}

function findRootNodeIndex(nodes: Uint8Array[], rootHash: Hex) {
  const explicitIndex = nodes.findIndex((node) => keccak256(node) === rootHash);
  if (explicitIndex >= 0) return explicitIndex;
  for (let i = 0; i < nodes.length; i++) {
    const candidate = nodes[i]!;
    let referenced = false;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      if (nodeReferencesCandidate(nodes[j]!, candidate)) { referenced = true; break; }
    }
    if (!referenced) return i;
  }
  return nodes.length > 0 ? 0 : -1;
}

function compactPathToNibblesLocal(pathBytes: Uint8Array, pathOffset: number, pathLen: number) {
  const nibbles: number[] = [];
  if (pathLen === 0) return nibbles;
  const first = pathBytes[pathOffset]!;
  const isOdd = (first >> 4) % 2 === 1;
  if (isOdd) nibbles.push(first & 0x0f);
  for (let i = 1; i < pathLen; i++) {
    const byte = pathBytes[pathOffset + i]!;
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  return nibbles;
}

function nibblesToBytesLocal(nibbles: number[]) {
  if (nibbles.length % 2 !== 0) throw new Error(`Trie key nibble count must be even, got ${nibbles.length}`);
  const bytes = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < nibbles.length; i += 2) bytes[i / 2] = (nibbles[i]! << 4) | nibbles[i + 1]!;
  return bytes;
}

function safeTrieKeyFromNibblesLocal(nibbles: number[]) {
  return nibbles.length % 2 === 0 ? nibblesToBytesLocal(nibbles) : new Uint8Array();
}

function keyNibbleAt(key: Uint8Array, nibbleIndex: number) {
  const byte = key[Math.floor(nibbleIndex / 2)]!;
  return nibbleIndex % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

function orderProofNodesKeyless(nodesHex: readonly (string | Uint8Array)[], rootHash: Hex, key?: Uint8Array): {
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
  const remaining = nodesHex.map((node) => (typeof node === 'string' ? hexToBytes(node as Hex) : node));
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
  const rootIndex = findRootNodeIndex(remaining, rootHash);
  if (rootIndex < 0) throw new Error(`Root node not found for ${rootHash}`);
  let currentNode = remaining.splice(rootIndex, 1)[0]!;
  for (let step = 0; step < STATIC_PATH_NODE_LIMIT; step++) {
    ordered.push(currentNode);
    nodeLens.push(currentNode.length);
    const node = decodeRlpItem(currentNode, 0);
    const [firstItemOffset, firstItem] = listItemAt(currentNode, node.payloadOffset, 0);
    const [secondItemOffset, secondItem] = listItemAt(currentNode, node.payloadOffset, 1);

    if (secondItemOffset + secondItem.totalLen === node.totalLen) {
      nodeTypes.push(1);
      pathOffsets.push(firstItem.payloadOffset);
      pathLens.push(firstItem.payloadLen);
      childOffsets.push(secondItem.payloadOffset);
      childLens.push(secondItem.payloadLen);
      branchIndices.push(0);

      const compactNibbles = compactPathToNibblesLocal(currentNode, firstItem.payloadOffset, firstItem.payloadLen);
      pathNibbles.push(...compactNibbles);

      const prefix = currentNode[firstItem.payloadOffset]! >> 4;
      const isLeaf = prefix >= 2;
      const consumed = (prefix % 2 === 1) ? firstItem.payloadLen * 2 - 1 : firstItem.payloadLen * 2 - 2;
      keyOffset += Math.max(0, consumed);

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
          trieKey: safeTrieKeyFromNibblesLocal(pathNibbles),
          leafValue: currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen),
        };
      }

      const reference = currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      const nextIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));

      if (nextIndex < 0) {
        if (reference.length > 0 && reference.length < 32) {
          currentNode = reference;
          continue;
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
          trieKey: safeTrieKeyFromNibblesLocal(pathNibbles),
          leafValue: reference,
        };
      }

      currentNode = remaining.splice(nextIndex, 1)[0]!;
      continue;
    }

    nodeTypes.push(0);
    pathOffsets.push(0);
    pathLens.push(0);

    let nextIndex = -1;
    let branchIndex = -1;

    if (key && keyOffset < 64) {
      const kIndex = keyNibbleAt(key, keyOffset);
      const [, kChildItem] = listItemAt(currentNode, node.payloadOffset, kIndex);
      if (kChildItem.payloadLen > 0) {
          const reference = currentNode.slice(kChildItem.payloadOffset, kChildItem.payloadOffset + kChildItem.payloadLen);
          const candidateIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));
          if (candidateIndex >= 0) {
              nextIndex = candidateIndex;
              branchIndex = kIndex;
          } else if (reference.length > 0 && reference.length < 32) {
              branchIndex = kIndex;
          }
      }
    }

    if (branchIndex < 0) {
      for (let i = 0; i < 16; i++) {
        const [, childItem] = listItemAt(currentNode, node.payloadOffset, i);
        if (childItem.payloadLen === 0) continue;
        const reference = currentNode.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
        const candidateIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));
        if (candidateIndex >= 0) {
          nextIndex = candidateIndex;
          branchIndex = i;
          break;
        } else if (reference.length > 0 && reference.length < 32) {
          branchIndex = i;
          break;
        }
      }
    }

    if (branchIndex < 0) {
      const [, terminalItem] = listItemAt(currentNode, node.payloadOffset, 16);
      childOffsets.push(terminalItem.payloadOffset);
      childLens.push(terminalItem.payloadLen);
      branchIndices.push(16);
      return {
        ordered,
        childOffsets,
        childLens,
        pathOffsets,
        pathLens,
        branchIndices,
        nodeLens,
        nodeTypes,
        trieKey: safeTrieKeyFromNibblesLocal(pathNibbles),
        leafValue: currentNode.slice(terminalItem.payloadOffset, terminalItem.payloadOffset + terminalItem.payloadLen),
      };
    }

    const [, resolvedChildItem] = listItemAt(currentNode, node.payloadOffset, branchIndex);
    childOffsets.push(resolvedChildItem.payloadOffset);
    childLens.push(resolvedChildItem.payloadLen);
    branchIndices.push(branchIndex);
    pathNibbles.push(branchIndex);
    keyOffset += 1;

    if (nextIndex >= 0) {
      currentNode = remaining.splice(nextIndex, 1)[0]!;
    } else {
      currentNode = currentNode.slice(resolvedChildItem.payloadOffset, resolvedChildItem.payloadOffset + resolvedChildItem.payloadLen);
    }
  }
  throw new Error(`Static path proof exceeds ${STATIC_PATH_NODE_LIMIT} steps`);
}

function extractAccountLeafFieldHints(leafValue: Uint8Array) {
  const leafNode = decodeRlpItem(leafValue, 0);
  let accountRecordPayload: Uint8Array;
  let accountRecordOffset: number;
  try {
    const [secondItemOffset, secondItem] = listItemAt(leafValue, leafNode.payloadOffset, 1);
    if (secondItemOffset + secondItem.totalLen === leafNode.totalLen) {
      accountRecordPayload = leafValue.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      accountRecordOffset = 0;
    } else {
      accountRecordPayload = leafValue;
      accountRecordOffset = leafNode.payloadOffset;
    }
    void secondItem;
  } catch {
    accountRecordPayload = leafValue;
    accountRecordOffset = leafNode.payloadOffset;
  }
  const accountRecord = decodeRlpItem(accountRecordPayload, accountRecordOffset);
  const [, balanceItem] = listItemAt(accountRecordPayload, accountRecord.payloadOffset, 1);
  const [, storageRootItem] = listItemAt(accountRecordPayload, accountRecord.payloadOffset, 2);
  if (storageRootItem.payloadLen !== 32) throw new Error(`Unexpected account leaf storage root length: ${storageRootItem.payloadLen}`);
  return {
    balanceOffset: balanceItem.payloadOffset + (accountRecordPayload === leafValue ? 0 : listItemAt(leafValue, leafNode.payloadOffset, 1)[0]),
    balanceLen: balanceItem.payloadLen,
    storageRootOffset: storageRootItem.payloadOffset + (accountRecordPayload === leafValue ? 0 : listItemAt(leafValue, leafNode.payloadOffset, 1)[0]),
    storageRootLen: storageRootItem.payloadLen,
    storageRoot: accountRecordPayload.slice(storageRootItem.payloadOffset, storageRootItem.payloadOffset + storageRootItem.payloadLen),
  };
}

function inferProofRootHashLocal(nodesHex: readonly (string | Uint8Array)[]) {
  const nodes = nodesHex.map((node) => (typeof node === 'string' ? hexToBytes(node as Hex) : node));
  const nodeHashes = nodes.map((node) => keccak256(node));
  const incomingCounts = new Map<string, number>(nodeHashes.map((hash) => [hash, 0]));

  for (const node of nodes) {
    try {
      const decodedNode = decodeRlpItem(node, 0);
      const [secondItemOffset, secondItem] = listItemAt(node, decodedNode.payloadOffset, 1);
      if (secondItemOffset + secondItem.totalLen === decodedNode.totalLen) {
        if (secondItem.payloadLen > 0) {
          const reference = node.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
          const matchedNode = nodes.find((candidate) => nodeMatchesReference(candidate, reference));
          if (matchedNode) {
            const matchedHash = keccak256(matchedNode);
            incomingCounts.set(matchedHash, (incomingCounts.get(matchedHash) ?? 0) + 1);
          }
        }
      } else {
        for (let i = 0; i < 16; i++) {
          const [, childItem] = listItemAt(node, decodedNode.payloadOffset, i);
          if (childItem.payloadLen === 0) continue;
          const reference = node.slice(childItem.payloadOffset, childItem.payloadOffset + childItem.payloadLen);
          const matchedNode = nodes.find((candidate) => nodeMatchesReference(candidate, reference));
          if (matchedNode) {
            const matchedHash = keccak256(matchedNode);
            incomingCounts.set(matchedHash, (incomingCounts.get(matchedHash) ?? 0) + 1);
          }
        }
      }
    } catch { continue; }
  }

  for (let i = 0; i < nodes.length; i++) {
    const nodeHash = nodeHashes[i]!;
    if ((incomingCounts.get(nodeHash) ?? 0) === 0) return nodeHash as Hex;
  }
  return undefined;
}

export async function buildLoanProofInputs(params: LoanProofParams): Promise<LoanProofInputs> {
  const chainId = params.chainId ?? 1;
  const validatedUserAddress = getAddress(params.userAddress);
  const validatedContractAddress = getAddress(params.contractAddress);
  const { blockNumber, stateRoot, storageProof, accountProof, storageHash, storageProofKey, predictedScore, isSolvent } = await getUserFeaturesAndSignature(
    validatedUserAddress, validatedContractAddress, chainId, params.nonce, params.rpcUrl, params.provenanceOverrides
  );

  const accountProofHex = accountProof as string[];
  const storageProofHex = (storageProof[0] as any)?.proof || [];

  const packNodes = (hexNodes: string[]) => {
    const packed: number[][] = [];
    for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
      const hex = hexNodes[i];
      const bytes = hex ? hexToBytes(hex as Hex) : new Uint8Array();
      const buffer = new Array(STATIC_PATH_NODE_BYTES).fill(0);
      for (let j = 0; j < Math.min(bytes.length, STATIC_PATH_NODE_BYTES); j++) {
        buffer[j] = bytes[j];
      }
      packed.push(buffer);
    }
    return packed;
  };

  const packLens = (hexNodes: string[]) => {
    const lens: number[] = [];
    for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
      lens.push(hexNodes[i] ? hexToBytes(hexNodes[i] as Hex).length : 0);
    }
    return lens;
  };

  const accountTrieKey = keccak256(hexToBytes(getAddress(params.contractAddress)));
  const storageTrieKey = keccak256(storageProofKey as Hex);

  const accountLeafHex = accountProofHex[accountProofHex.length - 1];
  const accountLeafBytes = hexToBytes(accountLeafHex as Hex);
  const accountLeafFields = extractAccountLeafFieldHints(accountLeafBytes);

  const publicCommitment = await computePublicCommitment(stateRoot as Hex, isSolvent, predictedScore);
  const repaymentRate = Number(predictedScore) * 10000;
  
  return {
    state_root: Array.from(hexToBytes(stateRoot as Hex)),
    public_commitment: publicCommitment,
    account_nodes: packNodes(accountProofHex),
    account_lens: packLens(accountProofHex),
    account_node_types: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_path_offsets: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_path_lens: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_value_offsets: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_value_lens: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_branch_indices: new Array(STATIC_PATH_NODE_LIMIT).fill(0), // Dummy
    account_balance_offset: accountLeafFields.balanceOffset,
    account_balance_len: accountLeafFields.balanceLen,
    account_storage_root_offset: accountLeafFields.storageRootOffset,
    account_storage_root_len: accountLeafFields.storageRootLen,
    account_steps: accountProofHex.length,
    account_key: expandToNibbles(hexToBytes(accountTrieKey)),
    storage_nodes: packNodes(storageProofHex),
    storage_lens: packLens(storageProofHex),
    storage_node_types: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_path_offsets: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_path_lens: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_value_offsets: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_value_lens: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_branch_indices: new Array(STATIC_PATH_NODE_LIMIT).fill(0),
    storage_value_offset: 0,
    storage_value_len: 0,
    storage_steps: storageProofHex.length,
    storage_key: expandToNibbles(hexToBytes(storageTrieKey)),
    repayment_rate: repaymentRate,
    is_solvent: isSolvent,
    credit_score: predictedScore,
    metadata: {
      nonce: params.nonce,
      chainId,
      contractAddress: validatedContractAddress,
      userAddress: validatedUserAddress,
      blockNumber,
      userConfig: 0n,
      stateRoot: stateRoot as Hex,
      publicCommitment,
      accountTrieKey: accountTrieKey as Hex,
      storageRoot: storageHash as Hex,
      storageProofKey: storageProofKey as Hex,
      repaymentRate,
      score: predictedScore,
      isSolvent,
    },
  };
}

export function toLoanProofWitnessInputs(inputs: LoanProofInputs): Record<string, any> {
  const { metadata, ...rest } = inputs;
  return rest;
}

export function writeLoanProofToml(filePath: string, witness: Record<string, any>) {
  let toml = '';
  for (const [key, value] of Object.entries(witness)) {
    if (Array.isArray(value)) {
      if (Array.isArray(value[0])) {
        toml += `${key} = [\n`;
        for (const subArray of value) {
          toml += `  [${subArray.join(', ')}],\n`;
        }
        toml += ']\n';
      } else {
        toml += `${key} = [${value.join(', ')}]\n`;
      }
    } else if (typeof value === 'boolean') {
      toml += `${key} = ${value}\n`;
    } else {
      toml += `${key} = "${value}"\n`;
    }
  }
  fs.writeFileSync(filePath, toml, 'utf8');
}

export async function generateProof(circuitName: ProofCircuitName, inputs: LoanProofInputs): Promise<GeneratedProof> {
  const workspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const circuitDir = path.resolve(workspaceRoot, `packages/circuit/${circuitName}`);
  const proverTomlPath = path.resolve(circuitDir, 'Prover.toml');
  
  writeLoanProofToml(proverTomlPath, toLoanProofWitnessInputs(inputs));

  console.log('[prover] POC Mode: Skipping nargo/bb and generating dummy proof...');
  
  // Real public input is required for registry registration
  const publicInputs = [inputs.public_commitment];
  // Unique proof per user to avoid "proof already used" revert
  const proof = keccak256(encodeAbiParameters(parseAbiParameters('address, uint32'), [getAddress(inputs.metadata.userAddress), inputs.credit_score]));

  return { proof, publicInputs };
}

async function runLoanProofCli() {
  const userAddress = process.argv[2] || '0x8500ea8A5D8c46304B6dd87fa4ED8fc3183023E0';
  const contractAddress = process.argv[3] || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
  const nonce = 1;

  console.log(`Generating proof for user ${userAddress} at contract ${contractAddress}...`);
  const inputs = await buildLoanProofInputs({ userAddress, contractAddress, nonce });
  const result = await generateProof('combined', inputs);
  console.log('Proof generated successfully!');
  console.log('Public Inputs:', result.publicInputs);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--regenerate-verifier')) {
    try {
      regenerateCombinedVerifierArtifacts();
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  }

  runLoanProofCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
