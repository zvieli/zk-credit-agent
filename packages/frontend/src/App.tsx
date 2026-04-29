import { useEffect, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { createPublicClient, getAddress, http, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { buildScoreProofInputs, type GeneratedProof, type ScoreProofInputs } from './proverScore';
import { warmProofEngine } from './prover';
import ActionHub from './components/ActionHub';
import ConfigPanel from './components/ConfigPanel';
import SummaryPanel from './components/SummaryPanel';

type StepStatus = 'idle' | 'working' | 'complete' | 'error';
type FlowPhase = 'IDLE' | 'AXIOM_REQUESTED' | 'AXIOM_VERIFIED' | 'NOIR_PROVING' | 'COMPLETED';

type StepState = {
  status: StepStatus;
  message: string;
};

type StatusMap = {
  sync: StepState;
  request: StepState;
  verify: StepState;
  proof: StepState;
  submit: StepState;
};

type AxiomRequestResult = {
  txHash: `0x${string}`;
  queryId: string;
  queryHash: `0x${string}`;
  userAddress: `0x${string}`;
  blockNumber: string;
  creditPolicyAddress: `0x${string}`;
  axiomV2QueryAddress: `0x${string}`;
};

type GenerateLoanProofResult = GeneratedProof & {
  stateRoot: `0x${string}`;
  blockNumber: string;
  creditPolicyAddress: `0x${string}`;
  metadata: ScoreProofInputs['metadata'];
};

const contractAbi = [
  {
    inputs: [
      { internalType: 'bytes', name: 'proof', type: 'bytes' },
      { internalType: 'bytes32', name: 'commitment', type: 'bytes32' },
      { internalType: 'uint32', name: 'score', type: 'uint32' },
      { internalType: 'bool', name: 'isSolvent', type: 'bool' },
      { internalType: 'bytes32', name: 'proofHash', type: 'bytes32' },
      { internalType: 'uint32', name: 'nonce', type: 'uint32' },
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'bytes32', name: 'stateRoot', type: 'bytes32' },
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
    ],
    name: 'verifyAndRegisterScore',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const fallbackCreditPolicyAddress = (import.meta.env.VITE_CREDIT_POLICY_ADDRESS ?? '0x386121D50d8591873C8b8b15d666E3A3705978f8') as `0x${string}`;
const fallbackScoreRegistryAddress = (import.meta.env.VITE_SCORE_REGISTRY_ADDRESS ?? '0x65a44ee2218a4d56fbf6a7d1a65d267b65347e0b') as `0x${string}`;
const zeroBytes32 = `0x${'0'.repeat(64)}` as const;

const verifiedRootsAbi = [
  {
    inputs: [{ internalType: 'uint256', name: 'blockNumber', type: 'uint256' }],
    name: 'verifiedRoots',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const flowPhases: Array<{ phase: FlowPhase; label: string; description: string }> = [
  { phase: 'IDLE', label: 'Idle', description: 'Ready to sync' },
  { phase: 'AXIOM_REQUESTED', label: 'Axiom Requested', description: 'Root dispatch sent' },
  { phase: 'AXIOM_VERIFIED', label: 'Axiom Verified', description: 'Root visible on-chain' },
  { phase: 'NOIR_PROVING', label: 'Noir Proving', description: 'Backend generating proof' },
  { phase: 'COMPLETED', label: 'Completed', description: 'Score registered' },
];

function resolveBackendApiUrl(pathname: string) {
  const backendUrl = import.meta.env.VITE_BACKEND_URL;

  if (!backendUrl) {
    return new URL(pathname.replace(/^\//, ''), 'http://localhost:3001/').toString();
  }

  return new URL(pathname.replace(/^\//, ''), backendUrl.endsWith('/') ? backendUrl : `${backendUrl}/`).toString();
}

async function postBackendJson<T>(pathname: string, body: unknown, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(resolveBackendApiUrl(pathname), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(errorBody || `Request to ${pathname} failed with ${response.status}`);
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Network timeout');
    }

    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isZeroBytes32(value?: string | null) {
  return !value || value === zeroBytes32;
}

async function readVerifiedRootOnChain(rpcUrl: string, creditPolicyAddress: `0x${string}`, blockNumber: bigint) {
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, { timeout: 300000 }),
  });

  return publicClient.readContract({
    address: creditPolicyAddress,
    abi: verifiedRootsAbi,
    functionName: 'verifiedRoots',
    args: [blockNumber],
  }) as Promise<`0x${string}`>;
}

async function waitForVerifiedRoot(params: {
  rpcUrl: string;
  creditPolicyAddress: `0x${string}`;
  blockNumber: bigint;
  queryId: string;
  expectedStateRoot: `0x${string}`;
  onPoll?: (stateRoot: `0x${string}` | null) => void;
}) {
  const timeoutMs = Number(import.meta.env.VITE_AXIOM_POLL_TIMEOUT_MS ?? 2 * 60 * 1000);
  const intervalMs = Number(import.meta.env.VITE_AXIOM_POLL_INTERVAL_MS ?? 1000);
  const startedAt = Date.now();
  let pollCount = 0;

  if (!params.queryId) {
    throw new Error('Missing queryId for verified-root polling.');
  }

  console.log(`[axiom-sync] Waiting for verified root at block ${params.blockNumber.toString()} from ${params.creditPolicyAddress}...`);
  console.log(`[axiom-sync] Polling begins after queryId ${params.queryId} was returned by the API.`);

  while (Date.now() - startedAt < timeoutMs) {
    pollCount += 1;
    const onChainRoot = await readVerifiedRootOnChain(params.rpcUrl, params.creditPolicyAddress, params.blockNumber);
    const waitedMs = Date.now() - startedAt;

    if (pollCount === 1 || pollCount % 5 === 0) {
      console.log(`[axiom-sync] Poll ${pollCount}: waited ${waitedMs}ms for block ${params.blockNumber.toString()}`);
    }

    if (!isZeroBytes32(onChainRoot)) {
      console.log(`[axiom-poll] Found root ${onChainRoot} for block ${params.blockNumber.toString()}. Expected: ${params.expectedStateRoot}.`);
      params.onPoll?.(onChainRoot);

      if (onChainRoot.toLowerCase() === params.expectedStateRoot.toLowerCase()) {
        return onChainRoot;
      }

      console.warn(`[axiom-sync] Poll ${pollCount}: found on-chain root ${onChainRoot}, expected ${params.expectedStateRoot}`);
    }

    params.onPoll?.(null);
    await sleep(intervalMs);
  }

  throw new Error('Timed out waiting for verified root on-chain.');
}

function statusTone(status: StepStatus) {
  return status;
}

function formatHash(hash?: `0x${string}`) {
  if (!hash) {
    return 'not ready';
  }

  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function resolveOrFallbackAddress(value: string | undefined, fallback: `0x${string}`) {
  const normalized = value?.trim();

  if (!normalized) {
    return getAddress(fallback);
  }

  try {
    return getAddress(normalized as `0x${string}`);
  } catch {
    return getAddress(fallback);
  }
}

function isLocalForkSession(rpcUrl: string, chainName?: string) {
  const normalizedRpcUrl = rpcUrl.trim().toLowerCase();
  const normalizedChainName = chainName?.trim().toLowerCase() ?? '';

  if (
    normalizedRpcUrl.startsWith('http://127.0.0.1') ||
    normalizedRpcUrl.startsWith('https://127.0.0.1') ||
    normalizedRpcUrl.startsWith('http://localhost') ||
    normalizedRpcUrl.startsWith('https://localhost') ||
    normalizedRpcUrl.startsWith('http://[::1]') ||
    normalizedRpcUrl.startsWith('https://[::1]')
  ) {
    return true;
  }

  return normalizedChainName.includes('anvil') || normalizedChainName.includes('hardhat') || normalizedChainName.includes('localhost');
}

// Inline StepCard was extracted to src/components/StepCard.tsx

function App() {
  const { address, isConnected, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const hasInjectedProvider = typeof window !== 'undefined' && Boolean((window as any).ethereum);
  const [flowPhase, setFlowPhase] = useState<FlowPhase>('IDLE');
  const [status, setStatus] = useState<StatusMap>({
    sync: { status: 'idle', message: 'Fetch the latest verified state root.' },
    request: { status: 'idle', message: 'Dispatch the Axiom root request.' },
    verify: { status: 'idle', message: 'Poll for verified root finality.' },
    proof: { status: 'idle', message: 'Generate the Noir proof after verification.' },
    submit: { status: 'idle', message: 'Register the verified score on-chain.' },
  });
  const defaultRpcUrl = 'http://127.0.0.1:8545';
  const [rpcUrl, setRpcUrl] = useState(defaultRpcUrl);
  const [creditPolicyAddress, setCreditPolicyAddress] = useState('');
  const [scoreRegistryAddress, setScoreRegistryAddress] = useState('');
  const [deploymentChainId, setDeploymentChainId] = useState<number>(mainnet.id);
  const connectedChainId = chain?.id ?? walletClient?.chain?.id;
  const axiomSourceChainId = connectedChainId ?? deploymentChainId;
  const [userAddress, setUserAddress] = useState('');
  const [nonce, setNonce] = useState(() => Math.floor(Date.now() / 1000) >>> 0);
  const [scoreInputs, setScoreInputs] = useState<ScoreProofInputs | null>(null);
  const [combinedProof, setCombinedProof] = useState<GeneratedProof | null>(null);
  const [scoreTxHash, setScoreTxHash] = useState<`0x${string}` | null>(null);
  const [axiomDispatch, setAxiomDispatch] = useState<{ txHash: `0x${string}`; queryId: string; queryHash: `0x${string}`; verifiedRoot: `0x${string}` | null } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const resolvedCreditPolicyAddress = resolveOrFallbackAddress(creditPolicyAddress, fallbackCreditPolicyAddress);
  const resolvedScoreRegistryAddress = resolveOrFallbackAddress(scoreRegistryAddress, fallbackScoreRegistryAddress);

  useEffect(() => {
    if (scoreInputs || combinedProof || axiomDispatch) {
      (window as any).debugZK = {
        scoreInputs,
        combinedProof,
        axiomDispatch,
        flowPhase,
      };
      console.info('🛠️ Debug data updated! Type "debugZK" in console to inspect.');
    }
  }, [scoreInputs, combinedProof, axiomDispatch, flowPhase]);

  useEffect(() => {
    if (address && !userAddress) {
      setUserAddress(address);
    }
  }, [address, userAddress]);

  useEffect(() => {
    let cancelled = false;

    const applyFallbacks = () => {
      setRpcUrl(defaultRpcUrl);
      setCreditPolicyAddress(fallbackCreditPolicyAddress);
      setScoreRegistryAddress(fallbackScoreRegistryAddress);
      setDeploymentChainId(mainnet.id);
    };

    async function loadDeploymentConfig() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-store' });
        if (!response.ok) {
          applyFallbacks();
          return;
        }

        const deployment = await response.json() as {
          chainId?: number;
          rpcUrl?: string;
          creditPolicyAddress?: string;
          scoreRegistryAddress?: string;
        };

        if (cancelled) {
          return;
        }

        if (deployment.rpcUrl) {
          setRpcUrl(deployment.rpcUrl);
        }

        setCreditPolicyAddress(resolveOrFallbackAddress(deployment.creditPolicyAddress, fallbackCreditPolicyAddress));
        setScoreRegistryAddress(resolveOrFallbackAddress(deployment.scoreRegistryAddress, fallbackScoreRegistryAddress));
        setDeploymentChainId(mainnet.id);
      } catch {
        if (cancelled) {
          return;
        }

        applyFallbacks();
      }
    }

    void loadDeploymentConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  function resetFlowState(message = 'Ready to dispatch the Axiom root request.') {
    setAxiomDispatch(null);
    setCombinedProof(null);
    setScoreTxHash(null);
    setFlowPhase('IDLE');
    setStatus((current) => ({
      ...current,
      request: { status: 'idle', message },
      verify: { status: 'idle', message: 'Poll for verified root finality.' },
      proof: { status: 'idle', message: 'Generate the Noir proof after verification.' },
      submit: { status: 'idle', message: 'Register the verified score on-chain.' },
    }));
  }

  async function handleAxiomSync() {
    if (!userAddress) {
      setStatus((current) => ({
        ...current,
        sync: { status: 'error', message: 'Set the user, oracle, and ScoreRegistry addresses first.' },
      }));
      return;
    }

    setStatus((current) => ({
      ...current,
      sync: { status: 'working', message: 'Fetching state root and proof inputs.' },
    }));

    try {
      if (connectedChainId && connectedChainId !== mainnet.id && !isLocalForkSession(rpcUrl, chain?.name)) {
        setStatus((current) => ({
          ...current,
          sync: { status: 'error', message: `Switch wallet to chain ${mainnet.id} before syncing.` },
        }));
        return;
      }

      const forkClient = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl, { timeout: 300000 }),
      });
      const latestBlockNumber = await forkClient.getBlockNumber();

      console.log('[sync] calling:', resolveBackendApiUrl('/api/get-proof-data'));

      const aavePoolAddress = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

      const inputs = await buildScoreProofInputs({
        userAddress,
        contractAddress: aavePoolAddress,
        nonce,
        chainId: connectedChainId ?? deploymentChainId,
        scoreRegistryAddress: resolvedScoreRegistryAddress,
        rpcUrl,
        provenanceOverrides: { blockNumber: latestBlockNumber },
        logger: {
          fetching: (message) => console.info('[sync] fetching', message),
          rawResponse: (message) => console.info('[sync] raw response', message.length > 200 ? message.slice(0, 200) + '... [truncated]' : message),
          parsedData: (data) => console.info('[sync] parsed data', data),
          formattedData: (data) => console.info('[sync] formatted data', data),
          inputsReady: (readyInputs) => console.info('[sync] inputs ready', {
            accountNodes: Array.isArray(readyInputs.account_nodes) ? readyInputs.account_nodes.length : 0,
            storageNodes: Array.isArray(readyInputs.storage_nodes) ? readyInputs.storage_nodes.length : 0,
            accountSteps: readyInputs.account_steps,
            storageSteps: readyInputs.storage_steps,
            blockNumber: readyInputs.metadata.blockNumber.toString(),
            userConfig: readyInputs.metadata.userConfig.toString(),
            score: readyInputs.metadata.score,
          }),
        },
      });

      setScoreInputs(inputs);
      resetFlowState('Ready to dispatch the Axiom root request.');

      setStatus((current) => ({
        ...current,
        sync: {
          status: 'complete',
          message: `Fetched block ${inputs.metadata.blockNumber.toString()}, state root ${formatHash(inputs.metadata.stateRoot)}, and predicted credit score ${inputs.metadata.score}.`,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sync state root';
      setStatus((current) => ({
        ...current,
        sync: { status: 'error', message },
      }));
    }
  }

  async function handleRunAxiomNoirFlow() {
    if (!scoreInputs || status.sync.status !== 'complete') {
      setStatus((current) => ({
        ...current,
        request: { status: 'error', message: 'Run Axiom Sync before starting the flow.' },
      }));
      return;
    }

    if (!walletClient || !address) {
      setStatus((current) => ({
        ...current,
        submit: { status: 'error', message: 'Connect a wallet first.' },
      }));
      return;
    }

    if (connectedChainId && connectedChainId !== mainnet.id && !isLocalForkSession(rpcUrl, chain?.name)) {
      setStatus((current) => ({
        ...current,
        request: { status: 'error', message: `Switch wallet to chain ${mainnet.id} before dispatching Axiom.` },
      }));
      return;
    }

    const chainId = connectedChainId ?? deploymentChainId;
    const blockNumber = scoreInputs.metadata.blockNumber;
    const expectedStateRoot = scoreInputs.metadata.stateRoot;
    const expectedCommitment = scoreInputs.metadata.publicCommitment;

    setAxiomDispatch(null);
    setCombinedProof(null);
    setScoreTxHash(null);
    setFlowPhase('AXIOM_REQUESTED');
    setStatus((current) => ({
      ...current,
      request: { status: 'working', message: 'Dispatching the Axiom root request.' },
      verify: { status: 'idle', message: 'Waiting for the verified root to land on-chain.' },
      proof: { status: 'idle', message: 'Noir proving waits for Axiom finality.' },
      submit: { status: 'idle', message: 'Submission waits for a valid proof.' },
    }));

    let currentPhase: FlowPhase = 'AXIOM_REQUESTED';
    void warmProofEngine('combined');

    try {
      const requestResult = await postBackendJson<AxiomRequestResult>('/api/request-axiom-root', {
        userAddress,
        blockNumber,
        chainId: axiomSourceChainId,
        rpcUrl,
        creditPolicyAddress: resolvedCreditPolicyAddress,
      }, 60000);

      setAxiomDispatch({
        txHash: requestResult.txHash,
        queryId: requestResult.queryId,
        queryHash: requestResult.queryHash,
        verifiedRoot: null,
      });

      setStatus((current) => ({
        ...current,
        request: {
          status: 'complete',
          message: `Axiom request sent. queryId ${requestResult.queryId}, tx ${formatHash(requestResult.txHash)}.`,
        },
        verify: { status: 'working', message: 'Polling CreditPolicy.verifiedRoots for finality.' },
      }));

      const verifiedRoot = await waitForVerifiedRoot({
        rpcUrl,
        creditPolicyAddress: resolvedCreditPolicyAddress,
        blockNumber,
        queryId: requestResult.queryId,
        expectedStateRoot,
        onPoll: (stateRoot) => {
          if (stateRoot) {
            setAxiomDispatch((current) => current ? { ...current, verifiedRoot: stateRoot } : current);
            setStatus((current) => ({
              ...current,
              verify: { status: 'working', message: `Waiting for verified root. Latest on-chain root: ${formatHash(stateRoot)}.` },
            }));
          }
        },
      });

      currentPhase = 'AXIOM_VERIFIED';
      setFlowPhase(currentPhase);
      setAxiomDispatch((current) => current ? { ...current, verifiedRoot } : current);
      setStatus((current) => ({
        ...current,
        verify: { status: 'complete', message: `Verified root confirmed on-chain: ${formatHash(verifiedRoot)}.` },
        proof: { status: 'working', message: 'Generating ZK Proof... This can take up to 2 minutes on local hardware.' },
      }));

      currentPhase = 'NOIR_PROVING';
      setFlowPhase(currentPhase);
      const proof = await postBackendJson<GenerateLoanProofResult>('/api/generate-loan-proof', {
        userAddress,
        blockNumber,
        chainId,
        rpcUrl,
        creditPolicyAddress: resolvedCreditPolicyAddress,
        nonce,
      }, 300000);

      if (!proof.publicInputs.length) {
        throw new Error('Backend proof response missing public inputs.');
      }

      const proofCommitment = proof.publicInputs[0] as `0x${string}`;
      const backendMetadata = proof.metadata;

      if (backendMetadata) {
        if (backendMetadata.publicCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
          console.log('[axiom-sync] Backend commitment:', backendMetadata.publicCommitment);
          console.log('[axiom-sync] Frontend commitment:', expectedCommitment);
        }

        console.log('[axiom-sync] Using backend-verified metadata:', backendMetadata);
        setScoreInputs((current) => current ? { ...current, metadata: backendMetadata } : current);
      }

      const activeMetadata = backendMetadata ?? scoreInputs.metadata;

      setCombinedProof(proof);
      setStatus((current) => ({
        ...current,
        proof: { status: 'complete', message: `Backend Noir proof ready with ${proof.publicInputs.length} public inputs.` },
        submit: { status: 'working', message: 'Please sign the transaction in your wallet.' },
      }));

      const proofHash = keccak256(proof.proof);

      const hash = await walletClient.writeContract({
        address: resolvedCreditPolicyAddress,
        abi: contractAbi,
        functionName: 'verifyAndRegisterScore',
        args: [
          proof.proof,
          proofCommitment,
          activeMetadata.score,
          activeMetadata.isSolvent,
          proofHash,
          activeMetadata.nonce,
          getAddress(userAddress),
          activeMetadata.stateRoot,
          BigInt(activeMetadata.blockNumber),
        ],
      });

      setStatus((current) => ({
        ...current,
        submit: { status: 'working', message: `Transaction sent: ${formatHash(hash)}. Waiting for confirmation...` },
      }));

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      setScoreTxHash(hash);
      currentPhase = 'COMPLETED';
      setFlowPhase(currentPhase);
      setStatus((current) => ({
        ...current,
        submit: { status: 'complete', message: `Verified credit score registered on-chain as DeFi oracle input: ${formatHash(hash)}` },
      }));
    } catch (error) {
      console.error('[axiom-sync] handleAxiomSync failed:', error);
      const message = error instanceof Error ? error.message : 'Axiom-to-Noir flow failed';
      const friendlyMessage = message.toLowerCase().includes('empty state root') || message.toLowerCase().includes('fork might be out of sync')
        ? 'The blockchain fork is catching up. Please wait 10 seconds and try again.'
        : message;
      setFlowPhase(currentPhase);
      setStatus((current) => ({
        ...current,
        request: currentPhase === 'AXIOM_REQUESTED' && current.request.status === 'working' ? { status: 'error', message: friendlyMessage } : current.request,
        verify: currentPhase === 'AXIOM_VERIFIED' && current.verify.status === 'working' ? { status: 'error', message: friendlyMessage } : current.verify,
        proof: currentPhase === 'NOIR_PROVING' && current.proof.status === 'working' ? { status: 'error', message: friendlyMessage } : current.proof,
        submit: current.submit.status === 'working' ? { status: 'error', message: friendlyMessage } : current.submit,
      }));
    }
  }

  const proofHash = combinedProof ? keccak256(combinedProof.proof) : undefined;

  return (
    <div className={`shell shell-${isConnected ? 'connected' : 'disconnected'}`}>
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />

      <div className="shell-chrome">
        <button type="button" className="chrome-toggle" onClick={() => setSidebarOpen((current) => !current)}>
          {sidebarOpen ? 'Hide settings' : 'Show settings'}
        </button>
        <button type="button" className="chrome-toggle" onClick={() => setDrawerOpen((current) => !current)}>
          {drawerOpen ? 'Hide proof data' : 'Show proof data'}
        </button>
      </div>

      <header className="hero">
        <div>
          <p className="eyebrow">Protocol v19 dashboard</p>
          <h1>Verified Credit Score Oracle</h1>
          <p className="lede">
            Sync proof inputs, dispatch Axiom first, wait for on-chain verification, then ask the backend to generate Noir and register the score.
          </p>
        </div>
        <div className="connect-panel">
          {hasInjectedProvider ? (
            <ConnectButton />
          ) : (
            <div className="wallet-notice">
              <strong>No injected wallet detected</strong>
              <span>Open this app in a browser profile with MetaMask or another injected wallet enabled.</span>
            </div>
          )}
          <div className="connect-meta">
            <span>{isConnected ? `Connected: ${address ?? 'unknown'}` : 'Wallet disconnected'}</span>
            <span>{chain ? `Chain ${chain.name}` : 'No chain selected'}</span>
          </div>
        </div>
      </header>

      <div className={`hidden-sidebar ${sidebarOpen ? 'is-open' : 'is-closed'}`}>
        <ConfigPanel
          rpcUrl={rpcUrl}
          setRpcUrl={setRpcUrl}
          creditPolicyAddress={creditPolicyAddress}
          setCreditPolicyAddress={setCreditPolicyAddress}
          scoreRegistryAddress={scoreRegistryAddress}
          setScoreRegistryAddress={setScoreRegistryAddress}
          nonce={nonce}
          setNonce={setNonce}
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen((current) => !current)}
        />
      </div>

      <main className="layout layout--centered">
        <ActionHub
          flowPhases={flowPhases}
          flowPhase={flowPhase}
          status={status}
          scoreInputs={scoreInputs}
          axiomDispatch={axiomDispatch}
          combinedProof={combinedProof}
          proofHash={proofHash}
          scoreTxHash={scoreTxHash}
          handleRunAxiomNoirFlow={handleRunAxiomNoirFlow}
          handleAxiomSync={handleAxiomSync}
          userAddress={userAddress}
          setUserAddress={setUserAddress}
        />

        <div className={`bottom-drawer ${drawerOpen ? 'is-open' : 'is-closed'}`}>
        <SummaryPanel
          scoreInputs={scoreInputs}
          resolvedCreditPolicyAddress={resolvedCreditPolicyAddress}
          axiomDispatch={axiomDispatch}
          scoreTxHash={scoreTxHash}
          isOpen={drawerOpen}
          onToggle={() => setDrawerOpen((current) => !current)}
        />
        </div>
      </main>
    </div>
  );
}

export default App;