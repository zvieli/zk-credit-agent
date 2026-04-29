import React from 'react';
import GlassCard from './GlassCard';
import FlowTracker from './FlowTracker';
import StepCard from './StepCard';

export default function PipelinePanel(props: any) {
  const {
    flowPhases,
    phaseIndex,
    status,
    scoreInputs,
    axiomDispatch,
    combinedProof,
    proofHash,
    scoreTxHash,
    handleRunAxiomNoirFlow,
    handleAxiomSync,
    userAddress,
  } = props;

  return (
    <GlassCard className="pipeline-card">
      <div className="pipeline-actions">
        <button
          onClick={handleRunAxiomNoirFlow}
          disabled={status.sync.status !== 'complete' || !scoreInputs || status.request.status === 'working' || status.verify.status === 'working' || status.proof.status === 'working' || status.submit.status === 'working'}
        >
          Run Axiom + Noir Flow
        </button>
      </div>

      <FlowTracker flowPhases={flowPhases} phaseIndex={phaseIndex} />

      <StepCard
        index="01"
        title="Axiom Sync"
        message={status.sync.message}
        status={status.sync.status}
        actionLabel="Sync state root"
        onAction={handleAxiomSync}
        disabled={!userAddress || status.sync.status === 'working'}
        details={scoreInputs ? (
          <div className="metrics">
            <div>
              <span>Block</span>
              <strong>{scoreInputs.metadata.blockNumber.toString()}</strong>
            </div>
            <div>
              <span>State root</span>
              <strong>{String(scoreInputs.metadata.stateRoot).slice(0, 10) + '…' + String(scoreInputs.metadata.stateRoot).slice(-8)}</strong>
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
        title="Axiom Requested"
        message={status.request.message}
        status={status.request.status}
        details={axiomDispatch ? (
          <div className="metrics">
            <div>
              <span>queryId</span>
              <strong>{axiomDispatch.queryId}</strong>
            </div>
            <div>
              <span>tx hash</span>
              <strong>{axiomDispatch.txHash ? (axiomDispatch.txHash.slice(0, 10) + '…' + axiomDispatch.txHash.slice(-8)) : 'pending'}</strong>
            </div>
            <div>
              <span>query hash</span>
              <strong>{axiomDispatch.queryHash ? (axiomDispatch.queryHash.slice(0, 10) + '…' + axiomDispatch.queryHash.slice(-8)) : 'pending'}</strong>
            </div>
          </div>
        ) : null}
      />

      <StepCard
        index="03"
        title="Axiom Verified"
        message={status.verify.message}
        status={status.verify.status}
        details={axiomDispatch?.verifiedRoot ? (
          <div className="metrics">
            <div>
              <span>Verified root</span>
              <strong>{axiomDispatch.verifiedRoot.slice(0, 10) + '…' + axiomDispatch.verifiedRoot.slice(-8)}</strong>
            </div>
            <div>
              <span>Expected root</span>
              <strong>{scoreInputs ? (String(scoreInputs.metadata.stateRoot).slice(0, 10) + '…' + String(scoreInputs.metadata.stateRoot).slice(-8)) : 'pending'}</strong>
            </div>
          </div>
        ) : null}
      />

      <StepCard
        index="04"
        title="Noir Proving"
        message={status.proof.message}
        status={status.proof.status}
        details={combinedProof ? (
          <div className="metrics">
            <div>
              <span>Proof</span>
              <strong>{combinedProof.proof ? (combinedProof.proof.slice(0, 10) + '…' + combinedProof.proof.slice(-8)) : 'not ready'}</strong>
            </div>
            <div>
              <span>Public inputs</span>
              <strong>{combinedProof.publicInputs.length}</strong>
            </div>
          </div>
        ) : null}
      />

      <StepCard
        index="05"
        title="Completed"
        message={status.submit.message}
        status={status.submit.status}
        details={(
          <div className="metrics">
            <div>
              <span>Proof hash</span>
              <strong>{proofHash ? (proofHash.slice(0, 10) + '…' + proofHash.slice(-8)) : 'not ready'}</strong>
            </div>
            <div>
              <span>Transaction</span>
              <strong>{scoreTxHash ? (scoreTxHash.slice(0, 10) + '…' + scoreTxHash.slice(-8)) : 'pending'}</strong>
            </div>
          </div>
        )}
      />
    </GlassCard>
  );
}
