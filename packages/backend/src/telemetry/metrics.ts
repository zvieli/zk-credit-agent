import client from "prom-client";

export const register = new client.Registry();

client.collectDefaultMetrics({ register, prefix: "zk_credit_" });

export const httpRequestsTotal = new client.Counter({
	name: "zk_credit_http_requests_total",
	help: "Total number of HTTP requests processed",
	labelNames: ["method", "route", "status"],
	registers: [register],
});

export const httpRequestDurationSeconds = new client.Histogram({
	name: "zk_credit_http_request_duration_seconds",
	help: "Duration of HTTP requests in seconds",
	labelNames: ["method", "route", "status"],
	buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
	registers: [register],
});

export const zkProofDurationSeconds = new client.Histogram({
	name: "zk_credit_proof_generation_duration_seconds",
	help: "Duration of zero-knowledge proof generation in seconds",
	labelNames: ["circuit_name", "status"],
	buckets: [1, 5, 10, 20, 30, 45, 60, 120],
	registers: [register],
});

export const zkProofFailuresTotal = new client.Counter({
	name: "zk_credit_proof_failures_total",
	help: "Total number of zero-knowledge proof generation failures",
	labelNames: ["circuit_name", "error_type"],
	registers: [register],
});

export const axiomQueriesTotal = new client.Counter({
	name: "zk_credit_axiom_queries_total",
	help: "Total number of Axiom state root queries initiated",
	labelNames: ["status"],
	registers: [register],
});

export const axiomQueryDurationSeconds = new client.Histogram({
	name: "zk_credit_axiom_query_duration_seconds",
	help: "Duration of Axiom state root resolution in seconds",
	labelNames: ["status"],
	buckets: [1, 2, 5, 10, 15, 30, 60],
	registers: [register],
});

export const relayerBalanceEth = new client.Gauge({
	name: "zk_credit_relayer_balance_eth",
	help: "Current ETH gas balance of agent/relayer wallet",
	labelNames: ["wallet"],
	registers: [register],
});

export const alertsTriggeredTotal = new client.Counter({
	name: "zk_credit_alerts_triggered_total",
	help: "Total number of security and operational alerts triggered",
	labelNames: ["severity", "category"],
	registers: [register],
});

export async function getMetrics(): Promise<string> {
	return register.metrics();
}
