import { Barretenberg, BackendType, UltraHonkBackend } from '@aztec/bb.js';
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js';
import { bytesToHex, type Hex } from 'viem';
import { ungzip } from 'pako';

type ProofCircuitName = 'account' | 'storage';

type GeneratedProof = {
  proof: Hex;
  publicInputs: string[];
};

type WorkerRequest =
  | {
      id: string;
      type: 'ensure-engine';
      circuitName: ProofCircuitName;
    }
  | {
      id: string;
      type: 'generate-proof';
      circuitName: ProofCircuitName;
      inputs: Record<string, unknown>;
    };

type WorkerResponse =
  | {
      id: string;
      type: 'log';
      message: string;
    }
  | {
      id: string;
      type: 'ready';
      circuitName: ProofCircuitName;
    }
  | {
      id: string;
      type: 'proof';
      proof: GeneratedProof;
    }
  | {
      id: string;
      type: 'error';
      error: string;
    };

type ProofEngine = {
  noir: Noir;
  backend: UltraHonkBackend;
};

const PROOF_CIRCUIT_URLS: Record<ProofCircuitName, string> = {
  account: '/account_circuit.json',
  storage: '/storage_circuit.json',
};

const circuitCache = new Map<ProofCircuitName, Promise<CompiledCircuit>>();
const proofEngineCache = new Map<ProofCircuitName, Promise<ProofEngine>>();
let barretenbergPromise: Promise<Barretenberg> | undefined;
let loadedSrsSize = 0;

console.info('[proof-worker] alive');

function post(response: WorkerResponse) {
  globalThis.postMessage(response);
}

function base64Decode(input: string): Uint8Array {
  return Uint8Array.from(atob(input), (character) => character.charCodeAt(0));
}

function acirToUint8Array(base64EncodedBytecode: string): Uint8Array {
  return ungzip(base64Decode(base64EncodedBytecode));
}

async function loadCompiledCircuit(circuitName: ProofCircuitName) {
  const cachedCircuit = circuitCache.get(circuitName);
  if (cachedCircuit) {
    return cachedCircuit;
  }

  const circuitPromise = (async () => {
    const circuitUrl = PROOF_CIRCUIT_URLS[circuitName];
    post({ id: `${circuitName}:fetch`, type: 'log', message: `[proof:${circuitName}] loading circuit from ${circuitUrl}` });
    const response = await fetch(circuitUrl, { cache: 'no-store' });

    if (!response.ok) {
      throw new Error(`Failed to load ${circuitName} circuit from ${circuitUrl}: ${response.status} ${response.statusText}`);
    }

    post({ id: `${circuitName}:fetch`, type: 'log', message: `[proof:${circuitName}] circuit response received, parsing JSON` });
    const circuit = await response.json() as CompiledCircuit;
    post({ id: `${circuitName}:fetch`, type: 'log', message: `[proof:${circuitName}] circuit JSON loaded successfully` });
    return circuit;
  })();

  circuitCache.set(circuitName, circuitPromise);
  return circuitPromise;
}

async function getBarretenberg() {
  if (!barretenbergPromise) {
    post({ id: 'barretenberg:init', type: 'log', message: '[proof-worker] starting Barretenberg initialization' });
    barretenbergPromise = Barretenberg.new({
      backend: BackendType.Wasm,
      threads: 1,
      logger: (message) => post({ id: 'barretenberg:log', type: 'log', message: `[proof-worker] ${message}` }),
      memory: {
        initial: 8192,
        maximum: 65536,
      },
    });
  }

  return barretenbergPromise;
}

async function getProofEngine(circuitName: ProofCircuitName): Promise<ProofEngine> {
  const cachedEngine = proofEngineCache.get(circuitName);
  if (cachedEngine) {
    return cachedEngine;
  }

  const enginePromise = (async () => {
    post({ id: `${circuitName}:engine`, type: 'log', message: `[proof:${circuitName}] starting engine initialization` });
    const circuit = await loadCompiledCircuit(circuitName);
    post({ id: `${circuitName}:engine`, type: 'log', message: `[proof:${circuitName}] circuit parsed, initializing Barretenberg and Noir` });
    const api = await getBarretenberg();
    if (loadedSrsSize === 0) {
      loadedSrsSize = api.getDefaultSrsSize();
    }

    const circuitBytecode = acirToUint8Array(circuit.bytecode);
    const [, requiredSrsSize] = await api.acirGetCircuitSizes(circuitBytecode, true, false);
    const targetSrsSize = Math.max(loadedSrsSize, requiredSrsSize);

    if (targetSrsSize > loadedSrsSize) {
      post({ id: `${circuitName}:crs`, type: 'log', message: `[proof:${circuitName}] resizing CRS to ${targetSrsSize + 1} points` });
      await api.initSRSChonk(targetSrsSize);
      loadedSrsSize = targetSrsSize;
    }

    post({ id: `${circuitName}:engine`, type: 'log', message: `[proof:${circuitName}] Barretenberg ready, creating Noir instance` });
    const noir = new Noir(circuit);
    post({ id: `${circuitName}:noir`, type: 'log', message: `[proof:${circuitName}] Noir instance created successfully!` });
    await noir.init();
    post({ id: `${circuitName}:noir`, type: 'log', message: `[proof:${circuitName}] Noir initialized successfully` });

    return {
      noir,
      backend: new UltraHonkBackend(circuit.bytecode, api),
    };
  })();

  proofEngineCache.set(circuitName, enginePromise);
  return enginePromise;
}

async function ensureEngine(circuitName: ProofCircuitName) {
  await getProofEngine(circuitName);
}

async function generateProof(circuitName: ProofCircuitName, inputs: Record<string, unknown>): Promise<GeneratedProof> {
  const proofEngine = await getProofEngine(circuitName);
  post({ id: `${circuitName}:witness`, type: 'log', message: `[proof-worker] Starting witness generation for ${circuitName}...` });
  const { witness } = await proofEngine.noir.execute(inputs as Record<string, unknown>);
  post({ id: `${circuitName}:witness`, type: 'log', message: `[proof-worker] Witness generated successfully for ${circuitName}` });
  post({ id: `${circuitName}:backend`, type: 'log', message: `[proof-worker] Starting backend.generateProof for ${circuitName}...` });
  const proofData = await proofEngine.backend.generateProof(witness, {
    verifierTarget: 'evm',
  });
  post({ id: `${circuitName}:backend`, type: 'log', message: `[proof-worker] ${circuitName} proof bytes=${proofData.proof.length}` });
  post({ id: `${circuitName}:backend`, type: 'log', message: `[proof-worker] Backend proof generated for ${circuitName}` });

  return {
    proof: bytesToHex(proofData.proof),
    publicInputs: proofData.publicInputs,
  };
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (!message || typeof message !== 'object') {
    return;
  }

  try {
    if (message.type === 'ensure-engine') {
      await ensureEngine(message.circuitName);
      post({ id: message.id, type: 'ready', circuitName: message.circuitName });
      return;
    }

    if (message.type === 'generate-proof') {
      const proof = await generateProof(message.circuitName, message.inputs);
      post({ id: message.id, type: 'proof', proof });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown proof worker error';
    post({ id: message.id, type: 'error', error: errorMessage });
  }
};