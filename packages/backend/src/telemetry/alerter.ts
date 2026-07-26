import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { alertsTriggeredTotal } from "./metrics.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ALERTS_LOG_PATH = resolve(__dirname, "../../logs/alerts.json");

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertEvent {
	severity: AlertSeverity;
	category: "zk_prover" | "axiom_relayer" | "wallet_balance" | "rpc_error";
	title: string;
	message: string;
	metadata?: Record<string, unknown>;
}

export async function dispatchAlert(event: AlertEvent): Promise<void> {
	alertsTriggeredTotal.inc({
		severity: event.severity,
		category: event.category,
	});

	const timestamp = new Date().toISOString();
	const alertRecord = {
		timestamp,
		alert: true,
		...event,
	};

	if (event.severity === "critical") {
		logger.error({ alert: alertRecord }, `[ALERT CRITICAL] ${event.title}: ${event.message}`);
	} else if (event.severity === "warning") {
		logger.warn({ alert: alertRecord }, `[ALERT WARNING] ${event.title}: ${event.message}`);
	} else {
		logger.info({ alert: alertRecord }, `[ALERT INFO] ${event.title}: ${event.message}`);
	}

	try {
		mkdirSync(dirname(ALERTS_LOG_PATH), { recursive: true });
		appendFileSync(ALERTS_LOG_PATH, `${JSON.stringify(alertRecord)}\n`, "utf-8");
	} catch (fileErr) {
		logger.error({ error: fileErr }, "Failed to write to alerts.json backup file");
	}

	const webhookUrl = process.env.ALERT_WEBHOOK_URL;
	if (webhookUrl) {
		try {
			const payload = {
				text: `🚨 *[${event.severity.toUpperCase()}] ${event.title}*\n*Category*: ${event.category}\n*Message*: ${event.message}\n\`\`\`${JSON.stringify(event.metadata || {}, null, 2)}\`\`\``,
			};
			await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		} catch (webhookErr) {
			logger.error({ error: webhookErr }, "Failed to dispatch alert webhook");
		}
	}
}
