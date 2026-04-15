/// <reference path="./sdk-shims.d.ts" />

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { hexToBytes, getAddress, keccak256 } from 'viem';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { getUserFeaturesAndSignature } from './index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Hex = `0x${string}`;
export type ProofCircuitName = 'account' | 'storage';

const DEFAULT_AAVE_POOL_ADDRESS = getAddress(process.env.AAVE_V3_POOL_ADDRESS ?? '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');

export type GeneratedProof = {
  proof: Hex;
  publicInputs: string[];
};

export type LoanProofInputs = {
  account: Record<string, unknown>;
  storage: Record<string, unknown>;
  metadata: {
    nonce: number;
    chainId: number;
    contractAddress: Hex;
    userAddress: Hex;
    blockNumber: bigint;
    stateRoot: Hex;
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
};

const circuitFallbackPaths: Record<ProofCircuitName, string> = {
  account: path.resolve(__dirname, '../../frontend/public/account_circuit.json'),
  storage: path.resolve(__dirname, '../../frontend/public/storage_circuit.json'),
};

const circuitCache = new Map<ProofCircuitName, CompiledCircuit>();

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

function bytesToFieldHex(bytes: Uint8Array) {
  return `0x${Buffer.from(bytes).toString('hex').padStart(64, '0')}`;
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

function readArtifactFile(...candidates: string[]) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
  }
  throw new Error(`Unable to find artifact file: ${candidates.join(', ')}`);
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

function describeStaticPathProof(nodesHex: readonly string[], rootHash: Hex, key: Uint8Array): {
  ordered: Uint8Array[];
  childOffsets: number[];
  nodeLens: number[];
  nodeTypes: number[];
  trieKey: Uint8Array;
  leafValue: Uint8Array;
} {
  try {
    const remaining = nodesHex.map((nodeHex) => hexToBytes(nodeHex as Hex));
    const ordered: Uint8Array[] = [];
    const childOffsets: number[] = [];
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
        const { isLeaf, consumed } = verifyCompactPath(currentNode, firstItem.payloadOffset, firstItem.payloadLen, key, keyOffset);
        const compactNibbles = compactPathToNibbles(currentNode, firstItem.payloadOffset, firstItem.payloadLen);
        pathNibbles.push(...compactNibbles);
        keyOffset += consumed;
        childOffsets.push(secondItemOffset);

        if (isLeaf) {
          return {
            ordered,
            childOffsets,
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

      if (keyOffset === 64) {
        const [terminalItemOffset, terminalItem] = listItemAt(currentNode, decodedNode.payloadOffset, 16);
        childOffsets.push(terminalItemOffset);

        if (terminalItem.payloadLen === 0) {
          throw new Error('Terminal branch node is missing its value item');
        }

        return {
          ordered,
          childOffsets,
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

      if (nextIndex < 0) {
        if (reference.length > 0 && reference.length < 32) {
          console.info('[sync] inline branch child fallback', { referenceLen: reference.length });
          pathNibbles.push(branchIndex);
          keyOffset += 1;
          childOffsets.push(candidateOffset);
          currentNode = reference;
          continue;
        }

        throw new Error('Unable to resolve branch child in static path proof');
      }

      pathNibbles.push(branchIndex);
      keyOffset += 1;
      childOffsets.push(candidateOffset);
      currentNode = remaining.splice(nextIndex, 1)[0]!;
    }

    throw new Error(`Static path proof exceeds ${STATIC_PATH_NODE_LIMIT} steps`);
  } catch (error) {
    console.info('[sync] keyless static path fallback', { reason: error instanceof Error ? error.message : String(error) });
    const fallbackNodes = nodesHex.map((nodeHex) => hexToBytes(nodeHex as Hex));
    return {
      ordered: fallbackNodes,
      childOffsets: [],
      nodeLens: fallbackNodes.map((node) => node.length),
      nodeTypes: [],
      trieKey: new Uint8Array(),
      leafValue: new Uint8Array(),
    };
  }
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

function orderProofNodesKeyless(nodesHex: readonly (string | Uint8Array)[], rootHash: Hex) {
  const remaining = nodesHex.map((node) => (typeof node === 'string' ? hexToBytes(node as Hex) : node));
  const ordered: Uint8Array[] = [];
  const pathNibbles: number[] = [];
  const rootIndex = remaining.findIndex((node) => keccak256(node) === rootHash);

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

function extractStorageRootFromAccountLeaf(leafValue: Uint8Array) {
  const leafNode = decodeRlpItem(leafValue, 0);
  const [, storageRootItem] = listItemAt(leafValue, leafNode.payloadOffset, 2);

  if (storageRootItem.payloadLen !== 32) {
    throw new Error(`Unexpected account leaf storage root length: ${storageRootItem.payloadLen}`);
  }

  return leafValue.slice(storageRootItem.payloadOffset, storageRootItem.payloadOffset + storageRootItem.payloadLen);
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
  const accountRealSteps = Number(accountPath.ordered.length);
  const storageRootBytes = Array.from(hexToBytes(storageHash as Hex));

  const storageProofKeyHex = storageProofKey as Hex;
  const recoveredStorageRoot = inferProofRootHash(flattenedStorageProof);
  const resolvedStorageRoot = resolveTrieRoot(storageHash as Hex | undefined, recoveredStorageRoot);
  const storageTrieKeyHex = keccak256(hexToBytes(storageProofKeyHex));
  const storageKeyBytes = hexToBytes(storageTrieKeyHex);
  const storagePath = describeStaticPathProof(flattenedStorageProof, resolvedStorageRoot, storageKeyBytes);
  const storageNodes = packStaticPathNodes(storagePath.ordered);
  const storageNodeLens = packStaticPathScalars(storagePath.nodeLens).map((value) => Number(value));
  const storageNodeTypes = packStaticPathScalars(storagePath.nodeTypes).map((value) => Number(value));
  const storageRealSteps = Number(storagePath.ordered.length);
  const storageRootHash = resolvedStorageRoot;

  const repaymentRate = Number(predictedScore) * 10_000;

  return {
    account: {
      nodes: accountNodes,
      lens: accountNodeLens,
      steps: accountRealSteps,
      key: expandToNibbles(accountTrieKeyBytes),
      state_root: Array.from(hexToBytes(inferredStateRoot)),
      storage_root: storageRootBytes,
    },
    storage: {
      repayment_rate: repaymentRate,
      storage_root: storageRootBytes,
      nodes: storageNodes,
      lens: storageNodeLens,
      steps: storageRealSteps,
      key: expandToNibbles(storageKeyBytes),
      credit_score: predictedScore,
      is_solvent: isSolvent,
    },
    metadata: {
      nonce: params.nonce,
      chainId,
      contractAddress: validatedContractAddress as Hex,
      userAddress: validatedUserAddress as Hex,
      blockNumber,
      stateRoot: inferredStateRoot,
      accountTrieKey: accountTrieKeyHex,
      storageRoot: storageRootHash,
      storageProofKey: storageProofKeyHex,
      repaymentRate,
      score: predictedScore,
      isSolvent,
    },
  };
}

export async function generateProof(circuitName: ProofCircuitName, inputs: Record<string, unknown>): Promise<GeneratedProof> {
  const circuit = readCompiledCircuit(circuitName);
  const noir = new Noir(circuit);
  const bbPath = process.env.BB_PATH || '/home/user/.bb/bb';

  try {
    console.log(`[proof:${circuitName}] initializing noir`);
    await noir.init();
    console.log(`[proof:${circuitName}] executing witness`);
    if (circuitName === 'account') {
      const accountInputs = inputs as any;
      console.log(`[proof:${circuitName}] input summary`, {
        steps: accountInputs.steps,
        lens: Array.isArray(accountInputs.lens) ? accountInputs.lens.slice(0, 3) : undefined,
        keyPrefix: Array.isArray(accountInputs.key) ? accountInputs.key.slice(0, 4) : undefined,
        stateRootPrefix: Array.isArray(accountInputs.state_root) ? accountInputs.state_root.slice(0, 4) : undefined,
        storageRootPrefix: Array.isArray(accountInputs.storage_root) ? accountInputs.storage_root.slice(0, 4) : undefined,
      });
    } else if (circuitName === 'storage') {
      const storageInputs = inputs as any;
      console.log(`[proof:${circuitName}] input summary`, {
        steps: storageInputs.steps,
        lens: Array.isArray(storageInputs.lens) ? storageInputs.lens.slice(0, 3) : undefined,
        keyPrefix: Array.isArray(storageInputs.key) ? storageInputs.key.slice(0, 4) : undefined,
        storageRootPrefix: Array.isArray(storageInputs.storage_root) ? storageInputs.storage_root.slice(0, 4) : undefined,
        creditScore: storageInputs.credit_score,
        repaymentRate: storageInputs.repayment_rate,
      });
    }
    const { witness } = await noir.execute(inputs as any);
    
    const witnessPath = path.join('/tmp', `zk-credit-agent-${circuitName}-witness.gz`);
    const proofDir = path.join('/tmp', `zk-credit-agent-${circuitName}-proof`);
    const verificationKeyPath = path.join(path.dirname(circuitPaths[circuitName]), 'proof', 'vk');
    
    fs.rmSync(proofDir, { recursive: true, force: true });
    fs.mkdirSync(proofDir, { recursive: true });
    fs.writeFileSync(witnessPath, Buffer.from(witness));
    
    console.log(`[proof:${circuitName}] generating proof with bb cli`);
    execFileSync(
      bbPath,
      ['prove', '-b', circuitPaths[circuitName], '-w', witnessPath, '-k', verificationKeyPath, '-o', proofDir, '--verifier_target', 'evm'],
      {
        stdio: 'inherit',
        env: { ...process.env, OMP_NUM_THREADS: process.env.BB_THREADS ?? '4' },
      }
    );

    const proofBytes = readArtifactFile(path.join(proofDir, 'proof'), path.join(proofDir, 'proof', 'proof'));
    const publicInputsBytes = readArtifactFile(path.join(proofDir, 'public_inputs'), path.join(proofDir, 'proof', 'public_inputs'));
    
    const publicInputs: string[] = [];
    for (let offset = 0; offset < publicInputsBytes.length; offset += 32) {
      publicInputs.push(bytesToFieldHex(publicInputsBytes.subarray(offset, offset + 32)));
    }

    console.log(`[proof:${circuitName}] proof generated`);
    return { proof: bytesToHex(proofBytes), publicInputs };
  } catch (error) {
    console.error(`Proof generation failed for ${circuitName} circuit`);
    throw error;
  }
}