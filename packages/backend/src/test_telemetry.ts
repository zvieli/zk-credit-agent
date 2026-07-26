import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	alertsTriggeredTotal,
	dispatchAlert,
	getMetrics,
	logger,
	runWithContext,
} from "./telemetry/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ALERTS_LOG_PATH = resolve(__dirname, "../logs/alerts.json");

async function main() {
	console.log("=== Testing Telemetry Layer ===");

	// 1. Test Trace Context Logger
	const testTraceId = "test-trace-uuid-12345";
	runWithContext({ traceId: testTraceId, userAddress: "0x123" }, () => {
		logger.info({ testPayload: "hello" }, "Testing context logger");
	});

	// 2. Test Alerting Engine
	console.log("Dispatching test alert...");
	await dispatchAlert({
		severity: "warning",
		category: "zk_prover",
		title: "Test Verification Alert",
		message: "Observability layer integration test alert",
		metadata: { testId: "unit-test-1" },
	});

	if (!existsSync(ALERTS_LOG_PATH)) {
		throw new Error(`Alert log file not created at ${ALERTS_LOG_PATH}`);
	}
	const alertContent = readFileSync(ALERTS_LOG_PATH, "utf-8");
	if (!alertContent.includes("Test Verification Alert")) {
		throw new Error("Test Verification Alert missing from alerts.json!");
	}
	console.log("✅ alerts.json verified!");

	// 3. Test Prometheus Metrics Exposition
	const metricsOutput = await getMetrics();
	if (!metricsOutput.includes("zk_credit_alerts_triggered_total")) {
		throw new Error("Prometheus metrics missing zk_credit_alerts_triggered_total!");
	}
	if (!metricsOutput.includes("zk_credit_http_requests_total")) {
		throw new Error("Prometheus metrics missing zk_credit_http_requests_total!");
	}
	console.log("✅ Prometheus metrics format verified!");
	console.log("\nSample Prometheus Exposition Output:\n", metricsOutput.slice(0, 400));
}

main().catch((err) => {
	console.error("Telemetry test failed:", err);
	process.exit(1);
});
