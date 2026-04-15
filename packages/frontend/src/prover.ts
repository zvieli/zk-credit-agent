import {
  bytesToHex,
  concatHex,
  getAddress,
  hexToBytes,
  keccak256,
  type Hex,
} from 'viem';

export type ProofCircuitName = 'account' | 'storage';

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

type LoanProofParams = {
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
  logger?: SyncLogger;
};

type BackendProofData = {
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
};

type SyncLogger = {
  fetching?: (message: string) => void;
  rawResponse?: (message: string) => void;
  parsedData?: (data: BackendProofData) => void;
  formattedData?: (data: { blockNumber: bigint; userConfig: bigint }) => void;
  inputsReady?: (inputs: LoanProofInputs) => void;
};

type SubmitScoreRequest = {
  userAddress: string;
  score: number;
  scoreRegistryAddress: string;
};

const DEFAULT_USDC_ADDRESS = getAddress(import.meta.env.VITE_USDC_ADDRESS ?? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const DEFAULT_USDT_ADDRESS = getAddress(import.meta.env.VITE_USDT_ADDRESS ?? '0xdAC17F958D2ee523a2206206994597C13D831ec7');
const DEFAULT_AAVE_POOL_ADDRESS = getAddress(import.meta.env.VITE_AAVE_POOL_ADDRESS ?? '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');

let workerInstance: Worker | undefined;
const proofRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timeoutId: number;
  }
>();

function getWorker() {
  if (workerInstance) {
    return workerInstance;
  }

  console.info('[ZK] Initializing singleton prover worker...');
  const workerUrl = new URL('./prover.worker.ts', import.meta.url);
  workerUrl.searchParams.set('v', `${Date.now()}`);
  workerInstance = new Worker(workerUrl, { type: 'module' });
  workerInstance.addEventListener('message', (event: MessageEvent<any>) => {
    const message = event.data;

    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'log') {
      console.info(message.message);
      return;
    }

    const pendingRequest = proofRequests.get(message.id);
    if (!pendingRequest) {
      return;
    }

    window.clearTimeout(pendingRequest.timeoutId);
    proofRequests.delete(message.id);

    if (message.type === 'ready') {
      pendingRequest.resolve(undefined);
      return;
    }

    if (message.type === 'proof') {
      pendingRequest.resolve(message.proof);
      return;
    }

    pendingRequest.reject(new Error(message.error || 'Proof worker error'));
  });

  workerInstance.addEventListener('error', (event) => {
    console.error('Proof worker error:', event.error ?? event.message);
  });

  return workerInstance;
}

function terminateProofWorker() {
  workerInstance?.terminate();
  workerInstance = undefined;
}

function postProofWorkerMessage<T>(message: { id: string; type: string; [key: string]: unknown }, timeoutMs: number): Promise<T> {
  const worker = getWorker();

  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      proofRequests.delete(message.id);
      terminateProofWorker();
      reject(new Error(`SES_DETECTION_ERROR: proof worker did not respond within ${timeoutMs}ms`));
    }, timeoutMs);

    proofRequests.set(message.id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timeoutId,
    });

    worker.postMessage(message);
  });
}

function resolveRpcUrl(explicitRpcUrl?: string) {
  return explicitRpcUrl ?? import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545';
}

function resolveBackendApiUrl(pathname: string) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;

  if (!backendUrl) {
    return pathname;
  }

  return new URL(pathname.replace(/^\//, ''), backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`).toString();
}

function flattenStorageProof(storageProof: BackendProofData['storageProof']) {
  if (!Array.isArray(storageProof) || storageProof.length === 0) {
    return [] as Hex[];
  }

  const firstEntry = storageProof[0];
  if (typeof firstEntry === 'string') {
    return storageProof as Hex[];
  }

  if (firstEntry && typeof firstEntry === 'object' && Array.isArray(firstEntry.proof)) {
    return firstEntry.proof;
  }

  return [] as Hex[];
}

async function postBackendJson<T>(pathname: string, body: unknown) {
  const response = await fetch(resolveBackendApiUrl(pathname), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(errorBody || `Request to ${pathname} failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function ensureEngine(circuitName: ProofCircuitName): Promise<void> {
  const requestId = crypto.randomUUID();
  await postProofWorkerMessage<void>({ id: requestId, type: 'ensure-engine', circuitName }, 900000);
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
    const fallback = orderProofNodesKeyless(nodesHex, rootHash);
    return {
      ordered: fallback.ordered,
      childOffsets: [],
      nodeLens: fallback.ordered.map((node) => node.length),
      nodeTypes: [],
      trieKey: fallback.trieKey,
      leafValue: fallback.leafValue,
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

function orderProofNodesKeyless(nodesHex: readonly string[], rootHash: Hex) {
  const remaining = nodesHex.map((nodeHex) => hexToBytes(nodeHex as Hex));
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
          ordered,
          trieKey: safeTrieKeyFromNibbles(pathNibbles),
          leafValue: currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen),
        };
      }

      const reference = currentNode.slice(secondItem.payloadOffset, secondItem.payloadOffset + secondItem.payloadLen);
      const nextIndex = remaining.findIndex((candidate) => nodeMatchesReference(candidate, reference));

      if (nextIndex < 0) {
        return {
          ordered: [...ordered, ...remaining],
          trieKey: safeTrieKeyFromNibbles(pathNibbles),
          leafValue: new Uint8Array(),
        };
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
        return {
          ordered: [...ordered, ...remaining],
          trieKey: safeTrieKeyFromNibbles(pathNibbles),
          leafValue: new Uint8Array(),
        };
      }

      pathNibbles.push(branchIndex);
      currentNode = remaining.splice(nextIndex, 1)[0]!;
    }
  }

  return { ordered: [...ordered, ...remaining], trieKey: safeTrieKeyFromNibbles(pathNibbles), leafValue: new Uint8Array() };
}

function inferProofRootHash(nodesHex: readonly string[]) {
  const nodes = nodesHex.map((nodeHex) => hexToBytes(nodeHex as Hex));
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

function extractStorageRootFromAccountLeaf(leafNode: Uint8Array, recordPayloadOffset: number) {
  const recordNode = decodeRlpItem(leafNode, recordPayloadOffset);
  const [, storageRootItem] = listItemAt(leafNode, recordNode.payloadOffset, 2);

  if (storageRootItem.payloadLen !== 32) {
    throw new Error(`Unexpected storage root length: ${storageRootItem.payloadLen}`);
  }

  return leafNode.slice(storageRootItem.payloadOffset, storageRootItem.payloadOffset + 32);
}

async function getUserFeaturesAndSignature(
  userAddress: string,
  contractAddress: string,
  chainId: number,
  nonce: number,
  rpcUrl?: string,
  overrides?: {
    blockNumber?: bigint;
    stateRoot?: Hex;
    storageProofAddress?: string;
    storageProofSlot?: Hex;
  },
  logger?: SyncLogger
) {
  const validatedAddress = getAddress(userAddress);
  const validatedContract = getAddress(contractAddress);

  logger?.fetching?.(`Fetching proof data for ${validatedAddress} at ${validatedContract}...`);

  const response = await fetch(resolveBackendApiUrl('/api/get-proof-data'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userAddress: validatedAddress,
      contractAddress: validatedContract,
      chainId,
      nonce,
      overrides,
    }),
  });

  const rawResponse = await response.text();
  logger?.rawResponse?.(rawResponse);

  if (!response.ok) {
    throw new Error(rawResponse || `Request to /api/get-proof-data failed with ${response.status}`);
  }

  const proofData = JSON.parse(rawResponse) as BackendProofData;
  logger?.parsedData?.(proofData);

  const blockNumber = BigInt(proofData.blockNumber);
  const userConfig = BigInt(proofData.userConfig ?? '0');
  logger?.formattedData?.({ blockNumber, userConfig });

  return {
    features: proofData.features ?? [],
    predictedScore: proofData.predictedScore,
    blockNumber,
    userConfig,
    stateRoot: proofData.stateRoot,
    storageProof: flattenStorageProof(proofData.storageProof),
    accountProof: proofData.accountProof ?? [],
    storageHash: proofData.storageHash,
    storageProofKey: proofData.storageProofKey,
    isSolvent: proofData.isSolvent ?? false,
  };
}

export async function requestScoreSubmission(params: SubmitScoreRequest) {
  const proofData = await postBackendJson<{ txHash: Hex }>('/api/submit-score', {
    userAddress: getAddress(params.userAddress),
    score: Math.max(0, Math.floor(params.score)),
    scoreRegistryAddress: getAddress(params.scoreRegistryAddress),
  });

  return proofData;
}

export async function buildLoanProofInputs(params: LoanProofParams): Promise<LoanProofInputs> {
  const chainId = params.chainId ?? 1;
  const validatedUserAddress = getAddress(params.userAddress);
  const validatedContractAddress = getAddress(params.contractAddress);

  const { blockNumber, userConfig, stateRoot, storageProof, accountProof, storageHash, storageProofKey, predictedScore, isSolvent } = await getUserFeaturesAndSignature(
    validatedUserAddress,
    validatedContractAddress,
    chainId,
    params.nonce,
    params.rpcUrl,
    params.provenanceOverrides,
    params.logger
  );

  console.info('[sync] start MPT parse');
  console.info('[sync] proof counts', {
    accountProof: accountProof.length,
    storageProof: storageProof.length,
  });

  const inferredStateRoot = inferProofRootHash(accountProof) ?? (stateRoot as Hex);
  console.info('[sync] state root inferred:', inferredStateRoot);

  // Account proof must match the Aave pool account proven by the backend.
  const accountTrieKeyBytes = hexToBytes(keccak256(hexToBytes(DEFAULT_AAVE_POOL_ADDRESS)));
  const accountTrieKeyHex = bytesToHex(accountTrieKeyBytes) as Hex;
  const accountTrieKeyNibbles = expandToNibbles(accountTrieKeyBytes);

  console.info('[sync] describe account path');
  const accountPath = describeStaticPathProof(accountProof, inferredStateRoot, accountTrieKeyBytes);
  console.info('[sync] account path described', {
    ordered: accountPath.ordered.length,
    nodeLens: accountPath.nodeLens,
    nodeTypes: accountPath.nodeTypes,
  });
  const lastAccountNode = accountPath.ordered[accountPath.ordered.length - 1]!;
  const [, accountRecordItem] = listItemAt(lastAccountNode, rlpHeaderLength(lastAccountNode[0]!), 1);
  const accountLeafStorageRootHex = bytesToHex(extractStorageRootFromAccountLeaf(lastAccountNode, accountRecordItem.payloadOffset)) as Hex;
  console.info('[sync] account leaf storage root', accountLeafStorageRootHex);
  const accountNodes = packStaticPathNodes(accountPath.ordered);
  const accountNodeLens = packStaticPathScalars(accountPath.nodeLens).map((value) => Number(value));
  const accountNodeTypes = packStaticPathScalars(accountPath.nodeTypes).map((value) => Number(value));
  const accountRealSteps = Number(accountPath.ordered.length);
  const storageProofKeyHex = storageProofKey as Hex;
  const storageTrieKeyHex = keccak256(hexToBytes(storageProofKeyHex));

  console.info('[sync] describe storage path');
  const inferredStorageRoot = resolveTrieRoot(accountLeafStorageRootHex, inferProofRootHash(storageProof) ?? (storageHash as Hex));
  console.info('[sync] storage root inferred:', inferredStorageRoot);
  const storagePath = describeStaticPathProof(storageProof, inferredStorageRoot, hexToBytes(storageTrieKeyHex));
  console.info('[sync] storage path described', {
    ordered: storagePath.ordered.length,
    nodeLens: storagePath.nodeLens,
    nodeTypes: storagePath.nodeTypes,
  });
  const storageNodes = packStaticPathNodes(storagePath.ordered);
  const storageNodeLens = packStaticPathScalars(storagePath.nodeLens).map((value) => Number(value));
  const storageNodeTypes = packStaticPathScalars(storagePath.nodeTypes).map((value) => Number(value));
  const storageRealSteps = Number(storagePath.ordered.length);
  const score = predictedScore;
  const repaymentRate = Number(score) * 10000;
  const storageRootBytes = Array.from(hexToBytes(inferredStorageRoot));
  const storageProofKeyBytes = Array.from(hexToBytes(storageTrieKeyHex));
  const storageProofKeyNibbles = expandToNibbles(hexToBytes(storageTrieKeyHex));

  const inputs: LoanProofInputs = {
    account: {
      nodes: accountNodes,
      lens: accountNodeLens,
      steps: accountRealSteps,
      key: accountTrieKeyNibbles,
      state_root: Array.from(hexToBytes(inferredStateRoot)),
      storage_root: storageRootBytes,
    },
    storage: {
      repayment_rate: repaymentRate,
      storage_root: storageRootBytes,
      nodes: storageNodes,
      lens: storageNodeLens,
      steps: storageRealSteps,
      key: storageProofKeyNibbles,
      is_solvent: isSolvent,
      credit_score: score,
    },
    metadata: {
      nonce: params.nonce,
      chainId,
      contractAddress: validatedContractAddress as Hex,
      userAddress: validatedUserAddress as Hex,
      blockNumber,
      userConfig,
      stateRoot: inferredStateRoot,
      accountTrieKey: accountTrieKeyHex,
      storageRoot: inferredStorageRoot,
      storageProofKey: storageProofKeyHex,
      repaymentRate,
      score,
      isSolvent,
    },
  };

  params.logger?.inputsReady?.(inputs);

  return inputs;
}

export async function generateProof(circuitName: ProofCircuitName, inputs: Record<string, unknown>): Promise<GeneratedProof> {
  console.info(`[proof:${circuitName}] generateProof invoked`);
  const requestId = crypto.randomUUID();

  await ensureEngine(circuitName);
  return postProofWorkerMessage<GeneratedProof>({ id: requestId, type: 'generate-proof', circuitName, inputs }, 900000);
}

export async function destroyProofEngine() {
  terminateProofWorker();
  proofRequests.clear();
}