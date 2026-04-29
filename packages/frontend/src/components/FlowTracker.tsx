import React from 'react';

export default function FlowTracker({ flowPhases, phaseIndex }: any) {
  return (
    <div className="flow-tracker" aria-label="Attestation progress">
      {flowPhases.map((item: any, index: number) => {
        const phaseState = index < phaseIndex ? 'complete' : index === phaseIndex ? 'active' : 'pending';

        return (
          <div key={item.phase} className={`flow-step ${phaseState}`}>
            <span className="flow-step-index">{String(index + 1).padStart(2, '0')}</span>
            <strong>{item.label}</strong>
            <small>{item.description}</small>
          </div>
        );
      })}
    </div>
  );
}
