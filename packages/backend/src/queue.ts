import { Queue } from "bullmq";
import Redis from "ioredis";
import { initBackendEnv } from "./env.ts";

initBackendEnv();

export const redisConnection = new Redis(
	process.env.REDIS_URL || "redis://localhost:6379",
	{
		maxRetriesPerRequest: null,
	},
);

export const proofQueue = new Queue("proof-jobs", {
	connection: redisConnection,
});
