import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendEnvInitialized = false;

export function initBackendEnv() {
	if (backendEnvInitialized) {
		return;
	}

	dotenv.config({ path: path.resolve(__dirname, "../.env") });
	dotenv.config({ path: path.resolve(__dirname, "../../.env") });
	backendEnvInitialized = true;
}

export type FrontendDeploymentConfig = {
	chainId?: number;
	rpcUrl?: string;
	proofRpcUrl?: string;
	creditPolicyAddress?: string;
	axiomV2QueryAddress?: string;
};

export function resolveFrontendDeploymentPath() {
	const candidates = [
		path.resolve(__dirname, "../../frontend/public/deployment.json"),
		path.resolve(process.cwd(), "../frontend/public/deployment.json"),
		path.resolve(process.cwd(), "packages/frontend/public/deployment.json"),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return candidates[0]!;
}

export function readFrontendDeploymentConfig(): FrontendDeploymentConfig {
	const deploymentPath = resolveFrontendDeploymentPath();

	if (!existsSync(deploymentPath)) {
		return {};
	}

	try {
		return JSON.parse(
			readFileSync(deploymentPath, "utf8"),
		) as FrontendDeploymentConfig;
	} catch {
		return {};
	}
}
