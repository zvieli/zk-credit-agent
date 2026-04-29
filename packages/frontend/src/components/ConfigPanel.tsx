import React from 'react';
import GlassCard from './GlassCard';

export default function ConfigPanel(props: any) {
  const {
    rpcUrl,
    setRpcUrl,
    creditPolicyAddress,
    setCreditPolicyAddress,
    scoreRegistryAddress,
    setScoreRegistryAddress,
    nonce,
    setNonce,
    isOpen,
    onToggle,
  } = props;

  return (
    <GlassCard className={`utility-panel utility-panel--sidebar ${isOpen ? 'is-open' : 'is-closed'}`}>
      <div className="utility-header">
        <div>
          <p className="utility-kicker">Hidden layer</p>
          <h3>Environment Settings</h3>
        </div>
        <button type="button" className="utility-toggle" onClick={onToggle}>
          {isOpen ? 'Hide' : 'Show'}
        </button>
      </div>

      {isOpen ? (
        <>
      <div className="card-header">
        <p>RPC endpoint, addresses, and nonce.</p>
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
        </>
      ) : null}
    </GlassCard>
  );
}
