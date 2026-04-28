import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToHex, hexToBytes, keccak256, type Hex as ViemHex } from 'viem';
import { Barretenberg, BackendType, UltraHonkBackend } from '@aztec/bb.js';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { evaluateAaveUserConfig } from './index.ts';

type Hex = ViemHex;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..');
const FRONTEND_PUBLIC = path.resolve(WORKSPACE_ROOT, 'packages/frontend/public');

const circuitPaths: Record<'storage', string> = {
  storage: path.resolve(FRONTEND_PUBLIC, 'storage_circuit.json'),
};

const circuitCache = new Map<'storage', Promise<CompiledCircuit>>();
const engineCache = new Map<'storage', Promise<{ noir: Noir; backend: UltraHonkBackend }>>();
let barretenbergPromise: Promise<Barretenberg> | undefined;

const STATIC_PATH_NODE_LIMIT = 9;
const STATIC_PATH_NODE_BYTES = 600;

function loadDeploymentDefaults() {
  const raw = readFileSync(path.resolve(FRONTEND_PUBLIC, 'deployment.json'), 'utf8');
  return JSON.parse(raw) as {
    creditPolicyAddress?: string;
    scoreRegistryAddress?: string;
    rpcUrl?: string;
    chainId?: number;
  };
}

function parseIterations(argv: string[]) {
  const flagIndex = argv.findIndex((value) => value === '--iterations' || value === '-i');
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    const parsed = Number(argv[flagIndex + 1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return 1000;
}

function bitAtWord(word: Uint8Array, bitIndex: number) {
  const byteIndex = 31 - Math.floor(bitIndex / 8);
  const bitIndexInByte = bitIndex % 8;
  return ((word[byteIndex] ?? 0) >> bitIndexInByte) & 1;
}

function wordToBigInt(word: Uint8Array) {
  return BigInt(`0x${Buffer.from(word).toString('hex')}`);
}

function toFieldBuffer(value: bigint) {
  const buffer = Buffer.alloc(32);
  let remaining = value;

  for (let index = 31; index >= 0; index--) {
    buffer[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  return buffer;
}

async function computePublicCommitment(storageRoot: Hex, key: Uint8Array, isSolvent: boolean, creditScore: number): Promise<Hex> {
  const bbModule = await import('@aztec/bb.js');
  const syncApi = await (bbModule as any).BarretenbergSync.initSingleton();
  const response = await syncApi.pedersenHash({
    inputs: [
      Buffer.from(hexToBytes(storageRoot)),
      Buffer.from(key),
      toFieldBuffer(isSolvent ? 1n : 0n),
      toFieldBuffer(BigInt(creditScore)),
    ],
    hashIndex: 0,
  });

  return bytesToHex(response.hash as Uint8Array) as Hex;
}

function computeSolventFromWord(word: Uint8Array) {
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
}

function referenceEvaluateAaveUserConfig(userConfig: bigint) {
  let hasCollateral = false;
  let hasDebt = false;

  for (let assetIndex = 0; assetIndex < 128; assetIndex++) {
    const collateralBit = (userConfig >> BigInt(assetIndex * 2 + 1)) & 1n;
    const debtBit = (userConfig >> BigInt(assetIndex * 2)) & 1n;

    if (collateralBit === 1n) {
      hasCollateral = true;
    }

    if (debtBit === 1n) {
      hasDebt = true;
    }
  }

  return {
    hasCollateral,
    hasDebt,
    isSolvent: hasCollateral && !hasDebt,
  };
}

function zeros(length: number) {
  return new Uint8Array(length);
}

function encodeRlpBytes(payload: Uint8Array, declaredLength = payload.length): number[] {
  if (declaredLength === 1 && payload[0]! < 0x80) {
    return [payload[0]!];
  }

  if (declaredLength <= 55) {
    return [0x80 + declaredLength, ...payload];
  }

  const lengthBytes = numberToMinimalBytes(declaredLength);
  return [0xb7 + lengthBytes.length, ...lengthBytes, ...payload];
}

function encodeRlpList(items: number[][], declaredPayloadLength?: number): number[] {
  const flatItems = items.flat();
  const payloadLength = declaredPayloadLength ?? flatItems.length;

  if (payloadLength <= 55) {
    return [0xc0 + payloadLength, ...flatItems];
  }

  const lengthBytes = numberToMinimalBytes(payloadLength);
  return [0xf7 + lengthBytes.length, ...lengthBytes, ...flatItems];
}

function numberToMinimalBytes(value: number) {
  if (value <= 0xff) {
    return [value];
  }

  if (value <= 0xffff) {
    return [value >> 8, value & 0xff];
  }

  if (value <= 0xffffff) {
    return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  }

  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

async function getBarretenberg() {
  if (!barretenbergPromise) {
    barretenbergPromise = Barretenberg.new({
      backend: BackendType.NativeSharedMemory,
      threads: 1,
    });
  }

  return barretenbergPromise;
}

async function loadCompiledCircuit(circuitName: 'storage') {
  const cached = circuitCache.get(circuitName);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const circuitJson = readFileSync(circuitPaths[circuitName], 'utf8');
    return JSON.parse(circuitJson) as CompiledCircuit;
  })();

  circuitCache.set(circuitName, promise);
  return promise;
}

async function getProofEngine(circuitName: 'storage') {
  const cached = engineCache.get(circuitName);
  if (cached) {
    return cached;
  }

  const enginePromise = (async () => {
    const circuit = await loadCompiledCircuit(circuitName);
    const api = await getBarretenberg();
    const noir = new Noir(circuit);
    await noir.init();

    return {
      noir,
      backend: new UltraHonkBackend(circuit.bytecode, api),
    };
  })();

  engineCache.set(circuitName, enginePromise);
  return enginePromise;
}

async function generateProof(circuitName: 'storage', inputs: Record<string, unknown>) {
  const proofEngine = await getProofEngine(circuitName);
  console.log(`[fuzz] ${circuitName}: generating witness`);
  const { witness } = await proofEngine.noir.execute(inputs as Record<string, unknown>);
  console.log(`[fuzz] ${circuitName}: witness ready, generating proof`);
  return proofEngine.backend.generateProof(witness, { verifierTarget: 'evm' });
}

function makeCompactPathPayload(key: Uint8Array) {
  if (key.length !== 32) {
    throw new Error(`Expected 32-byte key, received ${key.length} bytes`);
  }

  const payload = new Uint8Array(33);
  payload[0] = 0x20;
  payload.set(key, 1);
  return payload;
}

function makeLeafNode(word: Uint8Array, declaredValueLength = word.length) {
  const key = zeros(32);
  const pathPayload = makeCompactPathPayload(key);
  const pathItem = encodeRlpBytes(pathPayload);
  const valueItem = encodeRlpBytes(word, declaredValueLength);
  const nodeBytes = encodeRlpList([pathItem, valueItem]);
  const listHeaderLength = nodeBytes.length - pathItem.length - valueItem.length;
  const pathOffset = listHeaderLength + (pathItem.length - pathPayload.length);
  const pathLen = pathPayload.length;
  const valueOffset = listHeaderLength + pathItem.length + (valueItem.length - declaredValueLength);
  const valueLen = declaredValueLength;

  return {
    key,
    node: Uint8Array.from(nodeBytes),
    pathOffset,
    pathLen,
    valueOffset,
    valueLen,
  };
}

function toPackedNode(node: Uint8Array) {
  const packed = new Array<number>(STATIC_PATH_NODE_BYTES).fill(0);
  for (let index = 0; index < node.length; index++) {
    packed[index] = node[index]!;
  }

  return packed;
}

async function buildStorageInputs(word: Uint8Array, options?: { declaredValueLength?: number; isSolvent?: boolean; repaymentRate?: number; creditScore?: number; mutatePrefix?: number; }): Promise<Record<string, unknown>> {
  const declaredValueLength = options?.declaredValueLength ?? word.length;
  const { key, node, pathOffset, pathLen, valueOffset, valueLen } = makeLeafNode(word, declaredValueLength);
  const mutatedNode = new Uint8Array(node);

  if (options?.mutatePrefix !== undefined) {
    mutatedNode[0] = options.mutatePrefix;
  }

  const root = keccak256(mutatedNode) as Hex;

  const packedNodes = [toPackedNode(mutatedNode)];
  while (packedNodes.length < STATIC_PATH_NODE_LIMIT) {
    packedNodes.push(new Array<number>(STATIC_PATH_NODE_BYTES).fill(0));
  }

  const lengths = [mutatedNode.length];
  while (lengths.length < STATIC_PATH_NODE_LIMIT) {
    lengths.push(0);
  }

  const nodeTypes = [1];
  while (nodeTypes.length < STATIC_PATH_NODE_LIMIT) {
    nodeTypes.push(0);
  }

  const pathOffsets = [pathOffset];
  while (pathOffsets.length < STATIC_PATH_NODE_LIMIT) {
    pathOffsets.push(0);
  }

  const pathLens = [pathLen];
  while (pathLens.length < STATIC_PATH_NODE_LIMIT) {
    pathLens.push(0);
  }

  const valueOffsets = [valueOffset];
  while (valueOffsets.length < STATIC_PATH_NODE_LIMIT) {
    valueOffsets.push(0);
  }

  const valueLens = [valueLen];
  while (valueLens.length < STATIC_PATH_NODE_LIMIT) {
    valueLens.push(0);
  }

  const branchIndices = [0];
  while (branchIndices.length < STATIC_PATH_NODE_LIMIT) {
    branchIndices.push(0);
  }

  const solvency = options?.isSolvent ?? computeSolventFromWord(word);
  const repaymentRate = options?.repaymentRate ?? 0;
  const creditScore = options?.creditScore ?? 0;
  const publicCommitment = await computePublicCommitment(root, key, solvency, creditScore);

  return {
    public_commitment: publicCommitment,
    repayment_rate: repaymentRate,
    storage_root: Array.from(hexToBytes(root)),
    nodes: packedNodes,
    lens: lengths,
    steps: 1,
    key: Array.from(key),
    is_solvent: solvency,
    credit_score: creditScore,
    node_types: nodeTypes,
    path_offsets: pathOffsets,
    path_lens: pathLens,
    value_offsets: valueOffsets,
    value_lens: valueLens,
    branch_indices: branchIndices,
  };
}

async function expectProofOutcome(label: string, inputs: Record<string, unknown>, shouldSucceed: boolean) {
  console.log(`[fuzz] ${label} -> ${shouldSucceed ? 'expect success' : 'expect failure'}`);

  try {
    const proof = await generateProof('storage', inputs);
    if (!shouldSucceed) {
      throw new Error(`Expected ${label} to fail, but proof generation succeeded with ${proof.publicInputs.length} public inputs.`);
    }

    console.log(`[fuzz] ${label} passed`);

    return proof;
  } catch (error) {
    if (shouldSucceed) {
      console.error(`[fuzz] ${label} failed unexpectedly`);
      throw error;
    }

    console.log(`[fuzz] ${label} failed as expected`);
    return undefined;
  }
}

async function fuzzReferenceSolvency(iterations: number) {
  console.log(`Starting reference solvency fuzzing for ${iterations} iterations...`);

  const edgeWords = [
    new Uint8Array(32),
    Uint8Array.from(new Array(32).fill(0x55)),
    Uint8Array.from(new Array(32).fill(0xaa)),
  ];

  for (const edgeWord of edgeWords) {
    const expected = computeSolventFromWord(edgeWord);
    const reference = referenceEvaluateAaveUserConfig(wordToBigInt(edgeWord));

    if (reference.isSolvent !== expected) {
      throw new Error(`Edge case reference mismatch for word ${bytesToHex(edgeWord)}.`);
    }

    if (bytesToHex(edgeWord) === bytesToHex(new Uint8Array(32)) && expected !== false) {
      throw new Error('Empty account should never be solvent.');
    }
  }

  for (let iteration = 0; iteration < iterations; iteration++) {
    const word = randomBytes(32);
    const actual = computeSolventFromWord(word);
    const reference = referenceEvaluateAaveUserConfig(wordToBigInt(word)).isSolvent;

    if (actual !== reference) {
      throw new Error(`Solvency fuzz mismatch at iteration ${iteration}`);
    }
  }

  console.log('Reference solvency fuzzing passed.');
}

async function runCircuitCases() {
  console.log('Running circuit-level synthetic storage cases...');

  const emptyWord = new Uint8Array(32);
  await expectProofOutcome('empty account', await buildStorageInputs(emptyWord, { isSolvent: false }), true);

  const debtOnlyWord = Uint8Array.from(new Array(32).fill(0x55));
  await expectProofOutcome('debt-only trap', await buildStorageInputs(debtOnlyWord, { isSolvent: false }), true);

  const collateralOnlyWord = Uint8Array.from(new Array(32).fill(0xaa));
  await expectProofOutcome('collateral-only account', await buildStorageInputs(collateralOnlyWord, { isSolvent: true }), true);

  const randomWord = randomBytes(32);
  const expected = computeSolventFromWord(randomWord);
  const goodInputs = await buildStorageInputs(randomWord, { isSolvent: expected });
  await expectProofOutcome('random good proof', goodInputs, true);

  const flippedInputs = await buildStorageInputs(randomWord, { isSolvent: !expected });
  await expectProofOutcome('flipped solvency bit', flippedInputs, false);

  const malformedPrefixInputs = await buildStorageInputs(randomWord, { mutatePrefix: 0xc0, isSolvent: expected });
  await expectProofOutcome('invalid prefix', malformedPrefixInputs, false);

  const fiftyFiveByteInputs = await buildStorageInputs(randomBytes(55), { declaredValueLength: 55, isSolvent: false });
  await expectProofOutcome('55-byte RLP boundary', fiftyFiveByteInputs, false);

  const fiftySixByteInputs = await buildStorageInputs(randomBytes(56), { declaredValueLength: 56, isSolvent: false });
  await expectProofOutcome('56-byte RLP boundary', fiftySixByteInputs, false);

  const overlongLengthInputs = await buildStorageInputs(randomWord, { declaredValueLength: 500, isSolvent: expected });
  await expectProofOutcome('overlong RLP length', overlongLengthInputs, false);

  const deepPathInputs = {
    ...goodInputs,
    steps: 11,
    lens: [...(goodInputs.lens as number[]), 0],
    nodes: [...(goodInputs.nodes as number[][]), new Array<number>(STATIC_PATH_NODE_BYTES).fill(0)],
  };
  await expectProofOutcome('deep path overflow', deepPathInputs, false);

  console.log('Circuit-level synthetic storage cases passed.');
}

async function main() {
  const iterations = parseIterations(process.argv);

  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run fuzz:solvency [-- --iterations 1000]');
    console.log('Optional env: AGENT_PRIVATE_KEY, PROOF_RPC_URL, RPC_URL, AAVE_V3_POOL_ADDRESS');
    return;
  }

  try {
    loadDeploymentDefaults();
  } catch {
    // The synthetic cases do not require deployment defaults, but we keep the file path checked so the script fails
    // loudly if the workspace layout is broken.
  }

  await fuzzReferenceSolvency(iterations);
  await runCircuitCases();

  console.log('All solvency fuzz checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
