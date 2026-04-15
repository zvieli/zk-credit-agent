import { useEffect, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useWalletClient } from 'wagmi';
import { concatHex, createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'wagmi/chains';
import { buildScoreProofInputs, generateProof, type GeneratedProof, type ScoreProofInputs } from './proverScore';

type StepStatus = 'idle' | 'working' | 'complete' | 'error';

type StepState = {
  status: StepStatus;
  message: string;
};

type StatusMap = {
  sync: StepState;
  account: StepState;
  storage: StepState;
  submit: StepState;
};

const contractAbi = [
  {
    inputs: [
      { internalType: 'bytes', name: 'accountProof', type: 'bytes' },
      { internalType: 'bytes', name: 'storageProof', type: 'bytes' },
      { internalType: 'uint32', name: 'score', type: 'uint32' },
      { internalType: 'bool', name: 'isSolvent', type: 'bool' },
      { internalType: 'bytes32', name: 'proofHash', type: 'bytes32' },
      { internalType: 'uint32', name: 'nonce', type: 'uint32' },
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'bytes32', name: 'stateRoot', type: 'bytes32' },
      { internalType: 'bytes32', name: 'storageRoot', type: 'bytes32' },
      { internalType: 'bytes32', name: 'storageProofKey', type: 'bytes32' },
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
    ],
    name: 'verifyAndRegisterScore',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'blockNumber', type: 'uint256' },
      { internalType: 'bytes32', name: 'stateRoot', type: 'bytes32' },
    ],
    name: 'mockAxiomV2Callback',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const localDevPrivateKey = (import.meta.env.VITE_AGENT_PRIVATE_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
const localDevAccount = privateKeyToAccount(localDevPrivateKey);
const fallbackCreditPolicyAddress = (import.meta.env.VITE_CREDIT_POLICY_ADDRESS ?? '0xc2ebb3823477ada40ada4dacd12c1c9487b1dbbb') as `0x${string}`;
const fallbackScoreRegistryAddress = (import.meta.env.VITE_SCORE_REGISTRY_ADDRESS ?? '0x837d891a2b0e156433419ff01cf1d6970e62acd4') as `0x${string}`;

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

function StepCard(props: {
  index: string;
  title: string;
  message: string;
  status: StepStatus;
  actionLabel?: string;
  onAction?: () => Promise<void>;
  disabled?: boolean;
  details?: React.ReactNode;
}) {
  return (
    <div className={`step ${statusTone(props.status)}`}>
      <div className="step-header">
        <div>
          <span className="step-index">{props.index}</span>
          <h3>{props.title}</h3>
        </div>
        {props.onAction && props.actionLabel ? (
          <button onClick={props.onAction} disabled={props.disabled}>
            {props.actionLabel}
          </button>
        ) : null}
      </div>
      <p>{props.message}</p>
      {props.details}
    </div>
  );
}

function App() {
  const { address, isConnected, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const hasInjectedProvider = typeof window !== 'undefined' && Boolean((window as any).ethereum);
  const [status, setStatus] = useState<StatusMap>({
    sync: { status: 'idle', message: 'Fetch the latest verified state root.' },
    account: { status: 'idle', message: 'Generate the Noir account attestation proof.' },
    storage: { status: 'idle', message: 'Generate the Noir storage attestation proof.' },
    submit: { status: 'idle', message: 'Register the verified score on-chain.' },
  });
  const [rpcUrl, setRpcUrl] = useState(import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545');
  const [creditPolicyAddress, setCreditPolicyAddress] = useState('');
  const [scoreRegistryAddress, setScoreRegistryAddress] = useState('');
  const [borrowerAddress, setBorrowerAddress] = useState('');
  const [nonce, setNonce] = useState(() => Math.floor(Date.now() / 1000) >>> 0);
  const [scoreInputs, setScoreInputs] = useState<ScoreProofInputs | null>(null);
  const [accountProof, setAccountProof] = useState<GeneratedProof | null>(null);
  const [storageProof, setStorageProof] = useState<GeneratedProof | null>(null);
  const [scoreTxHash, setScoreTxHash] = useState<`0x${string}` | null>(null);
  const connectedChainId = chain?.id ?? walletClient?.chain?.id;
  const resolvedCreditPolicyAddress = resolveOrFallbackAddress(creditPolicyAddress, fallbackCreditPolicyAddress);
  const resolvedScoreRegistryAddress = resolveOrFallbackAddress(scoreRegistryAddress, fallbackScoreRegistryAddress);

  useEffect(() => {
    if (scoreInputs || accountProof || storageProof) {
      (window as any).debugZK = {
        scoreInputs,
        accountProof,
        storageProof,
      };
      console.info('🛠️ Debug data updated! Type "debugZK" in console to inspect.');
    }
  }, [scoreInputs, accountProof, storageProof]);

  useEffect(() => {
    if (address && !borrowerAddress) {
      setBorrowerAddress(address);
    }
  }, [address, borrowerAddress]);

  useEffect(() => {
    let cancelled = false;

    const applyFallbacks = () => {
      setRpcUrl(import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545');
      setCreditPolicyAddress(fallbackCreditPolicyAddress);
      setScoreRegistryAddress(fallbackScoreRegistryAddress);
    };

    async function loadDeploymentConfig() {
      try {
        const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, { cache: 'no-store' });
        if (!response.ok) {
          applyFallbacks();
          return;
        }

        const deployment = await response.json() as {
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

  async function handleAxiomSync() {
    if (!borrowerAddress) {
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
      if (connectedChainId && connectedChainId !== mainnet.id) {
        setStatus((current) => ({
          ...current,
          sync: { status: 'error', message: `Switch wallet to chain ${mainnet.id} before syncing.` },
        }));
        return;
      }

      console.info('[sync] start', {
        borrowerAddress,
        creditPolicyAddress: resolvedCreditPolicyAddress,
        scoreRegistryAddress: resolvedScoreRegistryAddress,
        chainId: chain?.id ?? Number(import.meta.env.VITE_CHAIN_ID ?? 1),
        nonce,
        rpcUrl,
      });

      const inputs = await buildScoreProofInputs({
        userAddress: borrowerAddress,
        contractAddress: resolvedScoreRegistryAddress,
        nonce,
        chainId: chain?.id ?? Number(import.meta.env.VITE_CHAIN_ID ?? 1),
        scoreRegistryAddress: resolvedScoreRegistryAddress,
        rpcUrl,
        logger: {
          fetching: (message) => console.info('[sync] fetching', message),
          rawResponse: (message) => console.info('[sync] raw response', message),
          parsedData: (data) => console.info('[sync] parsed data', data),
          formattedData: (data) => console.info('[sync] formatted data', data),
          inputsReady: (readyInputs) => console.info('[sync] inputs ready', {
            accountNodes: Array.isArray(readyInputs.account.nodes) ? readyInputs.account.nodes.length : 0,
            storageNodes: Array.isArray(readyInputs.storage.nodes) ? readyInputs.storage.nodes.length : 0,
            blockNumber: readyInputs.metadata.blockNumber.toString(),
            userConfig: readyInputs.metadata.userConfig.toString(),
            score: readyInputs.metadata.score,
          }),
        },
      });

      console.info('[sync] buildScoreProofInputs resolved', {
        blockNumber: inputs.metadata.blockNumber.toString(),
        userConfig: inputs.metadata.userConfig.toString(),
        score: inputs.metadata.score,
        isSolvent: inputs.metadata.isSolvent,
      });

      setScoreInputs(inputs);
      console.info('[sync] setScoreInputs complete');

      console.info('[sync] syncing oracle result on-chain', {
        blockNumber: inputs.metadata.blockNumber.toString(),
        stateRoot: inputs.metadata.stateRoot,
      });

      const localWalletClient = createWalletClient({
        account: localDevAccount,
        chain: mainnet,
        transport: http(rpcUrl),
      });

      const publicClient = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl),
      });

      const mockTxHash = await localWalletClient.sendTransaction({
        
        to: resolvedCreditPolicyAddress,
        data: encodeFunctionData({
          abi: contractAbi,
          functionName: 'mockAxiomV2Callback',
          args: [inputs.metadata.blockNumber, inputs.metadata.stateRoot],
        }),
        gas: 250_000n,
      });

      await publicClient.waitForTransactionReceipt({ hash: mockTxHash });
      setAccountProof(null);
      setStorageProof(null);
      setScoreTxHash(null);

      const syncMessage = `Fetched block ${inputs.metadata.blockNumber.toString()}, state root ${formatHash(inputs.metadata.stateRoot)}, and predicted credit score ${inputs.metadata.score}.`;

      setStatus((current) => ({
        ...current,
        sync: { status: 'complete', message: syncMessage },
        account: { status: 'idle', message: 'Generate the Noir account attestation proof.' },
        storage: { status: 'idle', message: 'Generate the Noir storage attestation proof.' },
        submit: { status: 'idle', message: 'Register the verified score on-chain.' },
      }));
    } catch (error) {
      console.error('[sync] CRASH:', error);
      const message = error instanceof Error ? error.message : 'Failed to sync state root';
      setStatus((current) => ({
        ...current,
        sync: { status: 'error', message },
      }));
    }
  }

  async function handleGenerateAllProofs() {
    if (!scoreInputs || status.sync.status !== 'complete') {
      setStatus((current) => ({
        ...current,
        account: { status: 'error', message: 'Run Axiom Sync before generating proofs.' },
      }));
      return;
    }

    setAccountProof(null);
    setStorageProof(null);
    setStatus((current) => ({
      ...current,
      account: { status: 'working', message: 'Generating the account proof in-browser.' },
      storage: { status: 'idle', message: 'Generate the Noir storage attestation proof.' },
      submit: { status: 'idle', message: 'Register the verified score on-chain.' },
    }));

    try {
      const account = await generateProof('account', scoreInputs.account);
      setAccountProof(account);
      setStatus((current) => ({
        ...current,
        account: { status: 'complete', message: `Account proof ready with ${account.publicInputs.length} public inputs.` },
        storage: { status: 'working', message: 'Generating the storage proof in-browser.' },
      }));

      const storage = await generateProof('storage', scoreInputs.storage);
      setStorageProof(storage);
      setStatus((current) => ({
        ...current,
        storage: { status: 'complete', message: `Storage proof ready with ${storage.publicInputs.length} public inputs.` },
      }));
    } catch (error) {
      console.error('Proof generation failed:', error);
      alert(error instanceof Error ? error.message : 'Proof generation failed');
      const message = error instanceof Error ? error.message : 'Proof generation failed';
      setStatus((current) => ({
        ...current,
        account: current.account.status === 'working' ? { status: 'error', message } : current.account,
        storage: current.storage.status === 'working' ? { status: 'error', message } : current.storage,
      }));
    }
  }

  async function handleRegisterVerifiedScore() {
    if (!scoreInputs || !accountProof || !storageProof) {
      setStatus((current) => ({
        ...current,
        submit: { status: 'error', message: 'Generate both proofs before registering the score.' },
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

    if (!borrowerAddress) {
      setStatus((current) => ({
        ...current,
        submit: { status: 'error', message: 'Set user address first.' },
      }));
      return;
    }

    setStatus((current) => ({
      ...current,
      submit: { status: 'working', message: 'Registering the verified score on-chain.' },
    }));

    try {
      const proofHash = keccak256(concatHex([accountProof.proof, storageProof.proof]));
      const localWalletClient = createWalletClient({
        account: localDevAccount,
        chain: mainnet,
        transport: http(rpcUrl),
      });

      console.info('[submit] targeting oracle contract', resolvedCreditPolicyAddress);

      const hash = await localWalletClient.sendTransaction({
        to: resolvedCreditPolicyAddress,
        data: encodeFunctionData({
          abi: contractAbi,
          functionName: 'verifyAndRegisterScore',
          args: [
            accountProof.proof,
            storageProof.proof,
            scoreInputs.metadata.score,
            scoreInputs.metadata.isSolvent,
            proofHash,
            scoreInputs.metadata.nonce,
            getAddress(borrowerAddress),
            scoreInputs.metadata.stateRoot,
            scoreInputs.metadata.storageRoot,
            scoreInputs.metadata.storageProofKey,
            scoreInputs.metadata.blockNumber,
          ],
        }),
          gas: 20_000_000n,
      });

      setScoreTxHash(hash);
      setStatus((current) => ({
        ...current,
        submit: { status: 'complete', message: `Verified credit score registered on-chain as oracle input: ${formatHash(hash)}` },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Score registration failed';
      setStatus((current) => ({
        ...current,
        submit: { status: 'error', message },
      }));
    }
  }


  const proofHash = accountProof && storageProof ? keccak256(concatHex([accountProof.proof, storageProof.proof])) : undefined;

  return (
    <div className={`shell shell-${isConnected ? 'connected' : 'disconnected'}`}>
      <div className="backdrop backdrop-a" />
      <div className="backdrop backdrop-b" />

      <header className="hero">
        <div>
          <p className="eyebrow">Protocol v19 dashboard</p>
          <h1>Verified Credit Score Oracle</h1>
          <p className="lede">
            Generate Noir proofs in the browser, sync the verified state root, and register a verified credit score through the connected wallet.
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

      <main className="layout">
        <section className="card config-card">
          <div className="card-header">
            <h2>Runtime configuration</h2>
            <p>Set the RPC endpoint and contract addresses for this session.</p>
          </div>

          <div className="field-grid">
            <label>
              <span>RPC URL</span>
              <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} placeholder="http://127.0.0.1:8545" />
            </label>
            <label>
              <span>Oracle contract address</span>
              <input value={creditPolicyAddress} onChange={(event) => setCreditPolicyAddress(event.target.value)} placeholder="0x..." />
            </label>
            <label>
              <span>Score registry address</span>
              <input value={scoreRegistryAddress} onChange={(event) => setScoreRegistryAddress(event.target.value)} placeholder="0x..." />
            </label>
            <label>
              <span>User address</span>
              <input value={borrowerAddress} onChange={(event) => setBorrowerAddress(event.target.value)} placeholder="0x..." />
            </label>
            <label>
              <span>Nonce</span>
              <input
                value={nonce}
                onChange={(event) => setNonce(Number(event.target.value) || 0)}
                inputMode="numeric"
                type="number"
                min={0}
              />
            </label>
          </div>
        </section>

        <section className="card pipeline-card">
          <div className="pipeline-actions">
            <button
              onClick={handleGenerateAllProofs}
              disabled={status.sync.status !== 'complete' || !scoreInputs || status.account.status === 'working' || status.storage.status === 'working'}
            >
              Generate Proofs
            </button>
          </div>

          <StepCard
            index="01"
            title="Axiom Sync"
            message={status.sync.message}
            status={status.sync.status}
            actionLabel="Sync state root"
            onAction={handleAxiomSync}
            disabled={!borrowerAddress || status.sync.status === 'working'}
            details={scoreInputs ? (
              <div className="metrics">
                <div>
                  <span>Block</span>
                  <strong>{scoreInputs.metadata.blockNumber.toString()}</strong>
                </div>
                <div>
                  <span>State root</span>
                  <strong>{formatHash(scoreInputs.metadata.stateRoot)}</strong>
                </div>
                <div>
                  <span>Predicted credit score</span>
                  <strong>{scoreInputs.metadata.score}</strong>
                </div>
              </div>
            ) : null}
          />

          <StepCard
            index="02"
            title="Account Attestation"
            message={status.account.message}
            status={status.account.status}
            details={accountProof ? (
              <div className="metrics">
                <div>
                  <span>Proof</span>
                  <strong>{formatHash(accountProof.proof)}</strong>
                </div>
                <div>
                  <span>Public inputs</span>
                  <strong>{accountProof.publicInputs.length}</strong>
                </div>
              </div>
            ) : null}
          />

          <StepCard
            index="03"
            title="Storage Attestation"
            message={status.storage.message}
            status={status.storage.status}
            details={storageProof ? (
              <div className="metrics">
                <div>
                  <span>Proof</span>
                  <strong>{formatHash(storageProof.proof)}</strong>
                </div>
                <div>
                  <span>Public inputs</span>
                  <strong>{storageProof.publicInputs.length}</strong>
                </div>
              </div>
            ) : null}
          />

          <StepCard
            index="04"
            title="Register Score"
            message={status.submit.message}
            status={status.submit.status}
            actionLabel="Register Score"
            onAction={handleRegisterVerifiedScore}
            disabled={!scoreInputs || !accountProof || !storageProof || !walletClient || !address || !borrowerAddress || status.submit.status === 'working'}
            details={(
              <div className="metrics">
                <div>
                  <span>Proof hash</span>
                  <strong>{proofHash ? formatHash(proofHash) : 'not ready'}</strong>
                </div>
                <div>
                  <span>Transaction</span>
                  <strong>{scoreTxHash ? formatHash(scoreTxHash) : 'pending'}</strong>
                </div>
              </div>
            )}
          />
        </section>

        <section className="card summary-card">
          <div className="card-header">
            <h2>Verified Credit Score summary</h2>
            <p>All inputs are computed client-side and submitted with the connected wallet.</p>
          </div>

          <div className="summary-grid">
            <div>
              <span>User</span>
              <strong>{scoreInputs ? scoreInputs.metadata.userAddress : borrowerAddress || 'unset'}</strong>
            </div>
            <div>
              <span>Oracle contract</span>
              <strong>{scoreInputs ? scoreInputs.metadata.contractAddress : resolvedCreditPolicyAddress}</strong>
            </div>
            <div>
              <span>State root</span>
              <strong>{scoreInputs ? scoreInputs.metadata.stateRoot : 'pending'}</strong>
            </div>
            <div>
              <span>Storage root</span>
              <strong>{scoreInputs ? scoreInputs.metadata.storageRoot : 'pending'}</strong>
            </div>
            <div>
              <span>Storage proof key</span>
              <strong>{scoreInputs ? scoreInputs.metadata.storageProofKey : 'pending'}</strong>
            </div>
            <div>
              <span>Oracle score</span>
              <strong>{scoreInputs ? scoreInputs.metadata.score.toLocaleString() : 'pending'}</strong>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;