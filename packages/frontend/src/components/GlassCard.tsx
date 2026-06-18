import type React from "react";

type Props = React.PropsWithChildren<{ className?: string }>;

export default function GlassCard({ children, className }: Props) {
	return <div className={`card glass-card ${className ?? ""}`}>{children}</div>;
}
