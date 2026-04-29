import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, lightTheme } from '@rainbow-me/rainbowkit';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { mainnet } from 'viem/chains';
import App from './App';
import './styles.css';
import '@rainbow-me/rainbowkit/styles.css';

(window as any).__ls_skip_lockdown = true;

const hasInjectedProvider = typeof window !== 'undefined' && Boolean((window as any).ethereum);

console.log('🛡️ Frontend Runtime Diagnostics:');
console.table({
  'Cross-Origin Isolated': window.crossOriginIsolated,
  'WebAssembly Support': typeof WebAssembly !== 'undefined',
  SharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  'Crypto Submodule': typeof crypto !== 'undefined' && !!crypto.subtle,
});

if (!window.crossOriginIsolated) {
  console.warn('⚠️ Warning: Not Cross-Origin Isolated. ZK proofs might fail or be slow.');
}

const queryClient = new QueryClient();

const localAnvil = {
  ...mainnet,
  id: 31337,
  name: 'Anvil Fork',
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
    public: { http: ['http://127.0.0.1:8545'] },
  },
};

const config = createConfig({
  chains: [localAnvil],
  connectors: hasInjectedProvider ? [injected()] : [],
  transports: {
    [localAnvil.id]: http('http://127.0.0.1:8545'),
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={lightTheme()}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>
);