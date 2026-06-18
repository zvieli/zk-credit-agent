import React from "react";
import GlassCard from "./GlassCard";
import StepCard from "./StepCard";

type StepStatus = "idle" | "working" | "complete" | "error";
type FlowPhase =
	| "IDLE"
	| "FUNDING"
	| "AXIOM_REQUESTED"
	| "AXIOM_VERIFIED"
	| "NOIR_PROVING"
	| "COMPLETED";

type StepState = {
	status: StepStatus;
	message: string;
};

export default function ActionHub(props: {
	flowPhases: Array<{ phase: FlowPhase; label: string; description: string }>;
	flowPhase: FlowPhase;
	status: {
		sync: StepState;
		funding: StepState;
		request: StepState;
		verify: StepState;
		proof: StepState;
		submit: StepState;
	};
	scoreInputs: any;
	axiomDispatch: any;
	combinedProof: any;
	proofHash?: string;
	scoreTxHash?: string | null;
	handleRunAxiomNoirFlow: () => Promise<void>;
	handleAxiomSync: () => Promise<void>;
	userAddress: string;
	setUserAddress: (value: string) => void;
}) {
	const {
		flowPhases,
		flowPhase,
		status,
		scoreInputs,
		axiomDispatch,
		combinedProof,
		proofHash,
		scoreTxHash,
		handleRunAxiomNoirFlow,
		handleAxiomSync,
		userAddress,
		setUserAddress,
	} = props;
	const activeIndex = Math.max(
		0,
		flowPhases.findIndex((item) => item.phase === flowPhase),
	);
	const activeStep = flowPhases[activeIndex] ?? flowPhases[0];
	const activeStatus =
		flowPhase === "IDLE"
			? status.sync.status
			: flowPhase === "FUNDING"
				? status.funding.status
				: flowPhase === "AXIOM_REQUESTED"
					? status.request.status
					: flowPhase === "AXIOM_VERIFIED"
						? status.verify.status
						: flowPhase === "NOIR_PROVING"
							? status.proof.status
							: status.submit.status;
	const activeMessage =
		flowPhase === "IDLE"
			? status.sync.message
			: flowPhase === "FUNDING"
				? status.funding.message
				: flowPhase === "AXIOM_REQUESTED"
					? status.request.message
					: flowPhase === "AXIOM_VERIFIED"
						? status.verify.message
						: flowPhase === "NOIR_PROVING"
							? status.proof.message
							: status.submit.message;

	const canSync = Boolean(userAddress) && status.sync.status !== "working";
	const canRun =
		status.sync.status === "complete" &&
		Boolean(scoreInputs) &&
		status.request.status !== "working" &&
		status.verify.status !== "working" &&
		status.proof.status !== "working" &&
		status.submit.status !== "working";

	async function handlePaste() {
		try {
			const pasted = await navigator.clipboard.readText();
			setUserAddress(pasted.trim());
		} catch {
			// clipboard unavailable
		}
	}

	return (
		<GlassCard className="action-hub">
			<div className="hub-primary-input">
				<label className="hub-address-field">
					<span>Target Wallet Address</span>
					<div className="hub-address-control">
						<input
							value={userAddress}
							onChange={(event) => setUserAddress(event.target.value)}
							placeholder="0x..."
							autoComplete="off"
							spellCheck={false}
						/>
						<button
							type="button"
							className="hub-paste-button"
							onClick={handlePaste}
							aria-label="Paste target wallet address"
						>
							<span aria-hidden="true">⎘</span>
							<span>Paste</span>
						</button>
					</div>
				</label>
			</div>

			<div className="hub-breadcrumbs" aria-label="Progress breadcrumbs">
				{flowPhases.map((item, index) => {
					const state =
						index < activeIndex
							? "done"
							: index === activeIndex
								? "active"
								: "next";
					return (
						<span key={item.phase} className={`hub-breadcrumb ${state}`}>
							{item.label}
						</span>
					);
				})}
			</div>

			<div className={`hub-hero is-${activeStatus}`}>
				<div className="hub-ring" aria-hidden="true">
					<span className="hub-ring-core" />
				</div>
				<div className="hub-copy">
					<p className="eyebrow">Action Hub</p>
					<h2>{activeStep.label}</h2>
					<p>{activeMessage}</p>
				</div>
			</div>

			{activeStep.phase === "IDLE" ? (
				<StepCard
					index="01"
					title="Environment Sync"
					message={status.sync.message}
					status={status.sync.status}
					actionLabel="Sync state root"
					onAction={handleAxiomSync}
					disabled={!canSync}
					details={
						scoreInputs ? (
							<div className="metrics metrics--compact">
								<div>
									<span>Block</span>
									<strong>{scoreInputs.metadata.blockNumber.toString()}</strong>
								</div>
								<div>
									<span>Score</span>
									<strong>{scoreInputs.metadata.score}</strong>
								</div>
							</div>
						) : null
					}
				/>
			) : activeStep.phase === "FUNDING" ? (
				<StepCard
					index="02"
					title="Funding"
					message={status.funding.message}
					status={status.funding.status}
					details={
						axiomDispatch ? (
							<div className="metrics metrics--compact">
								<div>
									<span>Escrow</span>
									<strong>0.1 ETH</strong>
								</div>
								<div>
									<span>Block</span>
									<strong>
										{scoreInputs
											? scoreInputs.metadata.blockNumber.toString()
											: "pending"}
									</strong>
								</div>
							</div>
						) : null
					}
				/>
			) : activeStep.phase === "AXIOM_REQUESTED" ? (
				<StepCard
					index="03"
					title="Axiom Request"
					message={status.request.message}
					status={status.request.status}
					details={
						axiomDispatch ? (
							<div className="metrics metrics--compact">
								<div>
									<span>Query</span>
									<strong>{axiomDispatch.queryId}</strong>
								</div>
								<div>
									<span>Tx</span>
									<strong>
										{axiomDispatch.txHash.slice(0, 10)}…
										{axiomDispatch.txHash.slice(-8)}
									</strong>
								</div>
							</div>
						) : null
					}
				/>
			) : activeStep.phase === "AXIOM_VERIFIED" ? (
				<StepCard
					index="04"
					title="Verified Root"
					message={status.verify.message}
					status={status.verify.status}
					details={
						axiomDispatch?.verifiedRoot ? (
							<div className="metrics metrics--compact">
								<div>
									<span>On-chain root</span>
									<strong>
										{axiomDispatch.verifiedRoot.slice(0, 10)}…
										{axiomDispatch.verifiedRoot.slice(-8)}
									</strong>
								</div>
							</div>
						) : null
					}
				/>
			) : activeStep.phase === "NOIR_PROVING" ? (
				<StepCard
					index="05"
					title="Proof Generation"
					message={status.proof.message}
					status={status.proof.status}
					details={
						combinedProof ? (
							<div className="metrics metrics--compact">
								<div>
									<span>Inputs</span>
									<strong>{combinedProof.publicInputs.length}</strong>
								</div>
								<div>
									<span>Proof hash</span>
									<strong>
										{proofHash
											? `${proofHash.slice(0, 10)}…${proofHash.slice(-8)}`
											: "pending"}
									</strong>
								</div>
							</div>
						) : null
					}
				/>
			) : (
				<StepCard
					index="06"
					title="Completion"
					message={status.submit.message}
					status={status.submit.status}
					details={
						scoreTxHash ? (
							<div className="metrics metrics--compact">
								<div>
									<span>Transaction</span>
									<strong>
										{scoreTxHash.slice(0, 10)}…{scoreTxHash.slice(-8)}
									</strong>
								</div>
							</div>
						) : null
					}
				/>
			)}

			<div className="hub-actions">
				{status.sync.status === "complete" ? (
					<button onClick={handleRunAxiomNoirFlow} disabled={!canRun}>
						Start attestation
					</button>
				) : (
					<button onClick={handleAxiomSync} disabled={!canSync}>
						Sync state root
					</button>
				)}
			</div>
		</GlassCard>
	);
}
