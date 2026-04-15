declare module '@noir-lang/noir_js' {
  export type CompiledCircuit = any;

  export class Noir {
    constructor(circuit: CompiledCircuit);
    init(): Promise<void>;
    execute(inputs: Record<string, unknown>, foreignCallHandler?: unknown): Promise<{
      witness: Uint8Array;
      returnValue: unknown;
    }>;
  }
}

declare module '@aztec/bb.js' {
  export enum BackendType {
    Wasm = 'Wasm',
    WasmWorker = 'WasmWorker',
    NativeUnixSocket = 'NativeUnixSocket',
    NativeSharedMemory = 'NativeSharedMemory',
  }

  export class Barretenberg {
    static new(options?: { backend?: BackendType; threads?: number; logger?: (message: string) => void; memory?: { initial: number; maximum: number } }): Promise<Barretenberg>;
    initSRSChonk(srsSize?: number): Promise<void>;
    getDefaultSrsSize(): number;
    acirGetCircuitSizes(bytecode: Uint8Array, recursive: boolean, honkRecursion: boolean): Promise<[number, number]>;
    destroy(): Promise<void>;
  }

  export class UltraHonkBackend {
    constructor(acirBytecode: string, api: Barretenberg);
    generateProof(compressedWitness: Uint8Array, options?: { verifierTarget?: 'evm' | 'evm-no-zk'; recursive?: boolean }): Promise<{
      proof: Uint8Array;
      publicInputs: string[];
    }>;
  }
}

declare module 'pako' {
  export function ungzip(input: Uint8Array): Uint8Array;
}