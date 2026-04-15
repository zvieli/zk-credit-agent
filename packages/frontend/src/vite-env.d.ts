/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_CREDIT_POLICY_ADDRESS?: string;
  readonly VITE_SCORE_REGISTRY_ADDRESS?: string;
  readonly VITE_AAVE_POOL_ADDRESS?: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_USDT_ADDRESS?: string;
  readonly VITE_BB_BACKEND?: 'Wasm' | 'WasmWorker';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}