import { type Job, Worker } from "bullmq";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";
import { generateLoanProof } from "./axiom_service.ts";
import { initBackendEnv } from "./env.ts";
import { redisConnection } from "./queue.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DEPLOYMENT_JSON_PATH = resolve(__dirname, "../../frontend/public/deployment.json");

initBackendEnv();

console.log("🚀 Proof Worker starting...");

const worker = new Worker(
	"proof-jobs",
	async (job: Job) => {
		console.log(
			`[Job ${job.id}] Processing proof for user: ${job.data.userAddress}`,
		);
		try {
			// Resilience check: Verify the block is seeded
			const targetBlockNumber = BigInt(job.data.blockNumber);
			const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
			let relayerAddress;

			try {
				const deployment = JSON.parse(readFileSync(DEPLOYMENT_JSON_PATH, "utf-8"));
				relayerAddress = getAddress(deployment.axiomV3RelayerAddress);
			} catch (err) {
				throw new Error("Could not read deployment.json to verify contract state.");
			}

			const client = createPublicClient({
				chain: { ...mainnet, id: 31337 },
				transport: http(rpcUrl),
			});

			const root = await client.readContract({
				address: relayerAddress,
				abi: [{
					inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
					name: "verifiedRoots",
					outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
					stateMutability: "view",
					type: "function",
				}],
				functionName: "verifiedRoots",
				args: [targetBlockNumber],
			});

			if (root === "0x0000000000000000000000000000000000000000000000000000000000000000") {
				throw new Error(`State not seeded: Relayer missing verified root for block ${targetBlockNumber}. Is the pre-flight seed step completing?`);
			}

			console.log(`[Job ${job.id}] Pre-flight check passed: verified root found for block ${targetBlockNumber}`);

			const result = await generateLoanProof({
				...job.data,
				blockNumber: targetBlockNumber,
			});
			console.log(`[Job ${job.id}] Proof generated successfully`);
			return result;
		} catch (error) {
			console.error(`[Job ${job.id}] Proof generation failed:`, error);
			throw error;
		}
	},
	{
		connection: redisConnection,
		concurrency: Number(process.env.PROVER_CONCURRENCY || 1),
	},
);

worker.on("failed", (job, err) => {
	console.error(`[Job ${job?.id}] Job failed with error: ${err.message}`);
});

worker.on("completed", (job) => {
	console.log(`[Job ${job.id}] Job completed!`);
});
