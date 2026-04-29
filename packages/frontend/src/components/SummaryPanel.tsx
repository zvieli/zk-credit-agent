import React from 'react';
import GlassCard from './GlassCard';

function copyToClipboard(text: string) {
  if (!text) return;
  try {
    void navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

export default function SummaryPanel(props: any) {
  const { scoreInputs, resolvedCreditPolicyAddress, axiomDispatch, scoreTxHash, isOpen, onToggle } = props;

  return (
    <GlassCard className={`utility-panel utility-panel--drawer ${isOpen ? 'is-open' : 'is-closed'}`}>
      <div className="utility-header">
        <div>
          <p className="utility-kicker">Hidden layer</p>
          <h3>Live Proof Data</h3>
        </div>
        <button type="button" className="utility-toggle" onClick={onToggle}>
          {isOpen ? 'Hide' : 'Show'}
        </button>
      </div>

      {isOpen ? (
        <>
      <div className="card-header">
        <p>Technical proof values and hashes.</p>
      </div>

      <div className="summary-grid">
        <div>
          <span>User</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(scoreInputs ? scoreInputs.metadata.userAddress : '')}>{scoreInputs ? scoreInputs.metadata.userAddress : 'unset'}</strong>
        </div>
        <div>
          <span>Oracle contract</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(scoreInputs ? scoreInputs.metadata.contractAddress : resolvedCreditPolicyAddress)}>{scoreInputs ? scoreInputs.metadata.contractAddress : resolvedCreditPolicyAddress}</strong>
        </div>
        <div>
          <span>Axiom query id</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(axiomDispatch?.queryId ?? '')}>{axiomDispatch?.queryId ?? 'pending'}</strong>
        </div>
        <div>
          <span>Axiom tx hash</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(axiomDispatch?.txHash ?? '')}>{axiomDispatch ? (axiomDispatch.txHash.slice(0, 10) + '…' + axiomDispatch.txHash.slice(-8)) : 'pending'}</strong>
        </div>
        <div>
          <span>State root</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(scoreInputs ? scoreInputs.metadata.stateRoot : '')}>{scoreInputs ? scoreInputs.metadata.stateRoot : 'pending'}</strong>
        </div>
        <div>
          <span>Storage root</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(scoreInputs ? scoreInputs.metadata.storageRoot : '')}>{scoreInputs ? scoreInputs.metadata.storageRoot : 'pending'}</strong>
        </div>
        <div>
          <span>Storage proof key</span>
          <strong className="clickable-hash" onClick={() => copyToClipboard(scoreInputs ? scoreInputs.metadata.storageProofKey : '')}>{scoreInputs ? scoreInputs.metadata.storageProofKey : 'pending'}</strong>
        </div>
        <div>
          <span>Oracle score</span>
          <strong>{scoreInputs ? scoreInputs.metadata.score.toLocaleString() : 'pending'}</strong>
        </div>
      </div>
        </>
      ) : null}
    </GlassCard>
  );
}
