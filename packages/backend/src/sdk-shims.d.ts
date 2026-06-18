declare module "@noir-lang/noir_js" {
	export type CompiledCircuit = any;

	export class Noir {
		constructor(circuit: CompiledCircuit);
		init(): Promise<void>;
		execute(
			inputs: Record<string, unknown>,
			foreignCallHandler?: unknown,
		): Promise<{
			witness: Uint8Array;
			returnValue: unknown;
		}>;
	}
}

declare module "@noir-lang/backend_barretenberg" {
	export class BarretenbergBackend {
		constructor(acirCircuit: any);
		generateProof(compressedWitness: Uint8Array): Promise<{
			proof: Uint8Array;
			publicInputs: string[];
		}>;
		destroy(): Promise<void>;
	}
}

declare module "@aztec/bb.js/dest/node/proof/index.js" {
	export function uint8ArrayToHex(buffer: Uint8Array): string;
}

declare module "@aztec/bb.js" {
	export enum BackendType {
		Wasm = "Wasm",
		WasmWorker = "WasmWorker",
		NativeUnixSocket = "NativeUnixSocket",
		NativeSharedMemory = "NativeSharedMemory",
	}

	export class Barretenberg {
		static new(options?: {
			backend?: BackendType;
			threads?: number;
		}): Promise<Barretenberg>;
		destroy(): Promise<void>;
	}

	export class UltraHonkBackend {
		constructor(acirBytecode: string, api: Barretenberg);
		generateProof(
			compressedWitness: Uint8Array,
			options?: { verifierTarget?: "evm" | "evm-no-zk" },
		): Promise<{
			proof: Uint8Array;
			publicInputs: string[];
		}>;
	}
}
