import type React from "react";

type StepStatus = "idle" | "working" | "complete" | "error";

export default function StepCard(props: {
	index: string;
	title: string;
	message: string;
	status: StepStatus;
	actionLabel?: string;
	onAction?: () => Promise<void> | void;
	disabled?: boolean;
	details?: React.ReactNode;
}) {
	const {
		index,
		title,
		message,
		status,
		actionLabel,
		onAction,
		disabled,
		details,
	} = props;

	return (
		<div className={`step ${status}`}>
			<div className="step-header">
				<div>
					<span className="step-index">{index}</span>
					<h3>{title}</h3>
				</div>
				{onAction && actionLabel ? (
					<button onClick={() => onAction()} disabled={disabled}>
						{actionLabel}
					</button>
				) : null}
			</div>
			<p>{message}</p>
			{details}
		</div>
	);
}
