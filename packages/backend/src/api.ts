import crypto from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type Chain,
	createPublicClient,
	createWalletClient,
	decodeErrorResult,
	getAddress,
	http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { startAxiomRelayer } from "./axiom_relayer.ts";
import {
	generateProof as generateBackendProof,
	prepareAxiomRequestArgs,
	relayAxiomRequest,
	requestAxiomRoot,
	resolveCreditPolicyAddress as resolveConfiguredCreditPolicyAddress,
} from "./axiom_service.ts";
import { initBackendEnv, readFrontendDeploymentConfig } from "./env.ts";
import { getUserFeaturesAndSignature } from "./index.ts";
import { proofQueue } from "./queue.ts";
import {
	dispatchAlert,
	getMetrics,
	httpRequestDurationSeconds,
	httpRequestsTotal,
	logger,
	runWithContext,
} from "./telemetry/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

initBackendEnv();

type Hex = `0x${string}`;
const MAINNET_CHAIN_ID = 1;

const scoreRegistryAbi = [
	{
		inputs: [
			{ internalType: "address", name: "user", type: "address" },
			{ internalType: "uint32", name: "score", type: "uint32" },
		],
		name: "setScore",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

const creditPolicyAbi = [
	{
		inputs: [
			{ internalType: "bytes", name: "proof", type: "bytes" },
			{ internalType: "bytes32", name: "commitment", type: "bytes32" },
			{ internalType: "uint32", name: "score", type: "uint32" },
			{ internalType: "bool", name: "isSolvent", type: "bool" },
			{ internalType: "bytes32", name: "proofHash", type: "bytes32" },
			{ internalType: "uint32", name: "nonce", type: "uint32" },
			{ internalType: "address", name: "user", type: "address" },
			{ internalType: "bytes32", name: "stateRoot", type: "bytes32" },
			{ internalType: "uint256", name: "blockNumber", type: "uint256" },
		],
		name: "verifyAndRegisterScore",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
] as const;

type ProofDataRequest = {
	userAddress?: string;
	contractAddress?: string;
	chainId?: number;
	nonce?: number;
	rpcUrl?: string;
	overrides?: {
		blockNumber?: bigint;
		stateRoot?: `0x${string}`;
		storageProofAddress?: string;
		storageProofSlot?: `0x${string}`;
	};
};

type SubmitScoreRequest = {
	userAddress?: string;
	score?: number;
	scoreRegistryAddress?: string;
};

type RegisterScoreRequest = {
	proof?: Hex;
	commitment?: Hex;
	score?: number;
	isSolvent?: boolean;
	proofHash?: Hex;
	nonce?: number;
	userAddress?: string;
	stateRoot?: Hex;
	blockNumber?: string | number | bigint;
	creditPolicyAddress?: string;
};

type GenerateProofRequest = {
	circuitName?: "account" | "storage" | "combined";
	inputs?: Record<string, unknown>;
};

type RequestAxiomRootRequest = {
	userAddress?: string;
	blockNumber?: string | number | bigint;
	chainId?: number;
	rpcUrl?: string;
	creditPolicyAddress?: string;
	axiomV2QueryAddress?: string;
	stateRoot?: string;
};

type RelayAxiomRequestBody = {
	sourceChainId?: string | number | bigint;
	dataQueryHash?: Hex;
	computeQuery?: {
		k?: number;
		resultLen?: number;
		vkey?: Hex[];
		computeProof?: Hex;
	};
	blockNumber?: string | number | bigint;
	feeData?: {
		maxFeePerGas?: string | number | bigint;
		callbackGasLimit?: number;
		overrideAxiomQueryFee?: string | number | bigint;
	};
	userSalt?: Hex;
	refundee?: string;
	dataQuery?: Hex;
	value?: string | number | bigint;
	creditPolicyAddress?: string;
	creditVerifierAddress?: string;
	rpcUrl?: string;
	userAddress?: string;
};

type GenerateLoanProofRequest = {
	userAddress?: string;
	blockNumber?: string | number | bigint;
	nonce?: number;
	chainId?: number;
	rpcUrl?: string;
	creditPolicyAddress?: string;
};

function resolveBackendPort() {
	return Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001);
}

function resolveProofRpcUrl() {
	if (process.env.ANVIL_RPC_URL) {
		return process.env.ANVIL_RPC_URL;
	}

	if (process.env.PROOF_RPC_URL) {
		return process.env.PROOF_RPC_URL;
	}

	if (process.env.RPC_URL) {
		return process.env.RPC_URL;
	}

	return "http://127.0.0.1:8545";
}

function resolveTransactionRpcUrl() {
	return (
		process.env.ANVIL_RPC_URL ??
		process.env.RPC_URL ??
		process.env.TX_RPC_URL ??
		"http://127.0.0.1:8545"
	);
}

function resolveRuntimeRpcChain(rpcUrl: string): Chain {
	const deployment = readFrontendDeploymentConfig();
	const chainId = Number(process.env.CHAIN_ID ?? deployment.chainId ?? 31337);

	return {
		...mainnet,
		id: chainId,
		rpcUrls: {
			default: { http: [rpcUrl] },
			public: { http: [rpcUrl] },
		},
	};
}

function resolveCreditPolicyAddress(contractAddress?: string) {
	const resolvedAddress = contractAddress ?? process.env.CREDIT_POLICY_ADDRESS;
	if (!resolvedAddress) {
		throw new Error("Missing CREDIT_POLICY_ADDRESS.");
	}

	return getAddress(resolvedAddress);
}

function resolveScoreRegistryAddress(address?: string) {
	const resolvedAddress = address ?? process.env.SCORE_REGISTRY_ADDRESS;
	if (!resolvedAddress) {
		throw new Error("Missing SCORE_REGISTRY_ADDRESS.");
	}

	return getAddress(resolvedAddress);
}

function resolveAgentPrivateKey() {
	const privateKey = process.env.AGENT_PRIVATE_KEY;
	if (!privateKey) {
		throw new Error("Missing AGENT_PRIVATE_KEY.");
	}

	return privateKey as Hex;
}

function setCorsHeaders(response: ServerResponse) {
	response.setHeader(
		"Access-Control-Allow-Origin",
		process.env.CORS_ORIGIN ?? "*",
	);
	response.setHeader("Access-Control-Allow-Headers", "content-type");
	response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(
	response: ServerResponse,
	statusCode: number,
	payload: unknown,
) {
	setCorsHeaders(response);
	response.writeHead(statusCode, { "Content-Type": "application/json" });
	response.end(
		JSON.stringify(payload, (_, value) =>
			typeof value === "bigint" ? value.toString() : value,
		),
	);
}

function readJsonBody(request: IncomingMessage): Promise<any> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];

		request.on("data", (chunk) =>
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
		);
		request.on("end", () => {
			const rawBody = Buffer.concat(chunks).toString("utf8").trim();

			if (!rawBody) {
				resolve(undefined);
				return;
			}

			try {
				resolve(JSON.parse(rawBody));
			} catch (error) {
				reject(error instanceof Error ? error : new Error("Invalid JSON body"));
			}
		});
		request.on("error", reject);
	});
}

function parseNumber(value: string | undefined, fallback?: number) {
	if (value === undefined || value === "") {
		return fallback;
	}

	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBigIntValue(value: string | number | bigint | undefined) {
	if (value === undefined || value === "") {
		return undefined;
	}

	if (typeof value === "bigint") {
		return value;
	}

	if (typeof value === "number") {
		return Number.isFinite(value) ? BigInt(Math.floor(value)) : undefined;
	}

	try {
		return BigInt(value);
	} catch {
		return undefined;
	}
}

function tryGetAddress(value: string | undefined, fieldName: string) {
	if (!value) {
		throw new Error(`Missing ${fieldName}.`);
	}

	try {
		return getAddress(value);
	} catch {
		throw new Error(`Invalid ${fieldName}.`);
	}
}

function formatRevertDetails(error: unknown, abi: readonly unknown[]) {
	const candidates: Array<{ label: string; value: unknown }> = [
		{ label: "error", value: error },
	];

	if (error && typeof error === "object") {
		const typedError = error as {
			cause?: unknown;
			data?: unknown;
			shortMessage?: unknown;
			details?: unknown;
		};
		if (typedError.cause) {
			candidates.push({ label: "cause", value: typedError.cause });
		}
		if (typedError.data) {
			candidates.push({ label: "data", value: typedError.data });
		}
	}

	for (const candidate of candidates) {
		const candidateValue = candidate.value as
			| {
					data?: unknown;
					cause?: unknown;
					shortMessage?: unknown;
					details?: unknown;
			  }
			| undefined;
		const hexData =
			typeof candidateValue?.data === "string" &&
			candidateValue.data.startsWith("0x")
				? candidateValue.data
				: undefined;

		if (!hexData) {
			continue;
		}

		try {
			const decoded = decodeErrorResult({
				abi: abi as never,
				data: hexData as `0x${string}`,
			});

			return `${candidate.label}: ${decoded.errorName}${decoded.args?.length ? `(${decoded.args.map((arg) => String(arg)).join(", ")})` : ""}`;
		} catch {
			return `${candidate.label}: ${hexData}`;
		}
	}

	if (error && typeof error === "object") {
		const typedError = error as {
			shortMessage?: unknown;
			details?: unknown;
			message?: unknown;
		};
		const message =
			typedError.shortMessage ?? typedError.details ?? typedError.message;
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
	}

	return "no revert data available";
}

function normalizeRoutePath(pathname: string) {
	return pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
}

async function handleRequestAxiomRoot(
	body: RequestAxiomRootRequest,
	response: ServerResponse,
) {
	if (!body.userAddress) {
		sendJson(response, 400, { error: "Missing userAddress." });
		return;
	}

	const blockNumber = parseBigIntValue(body.blockNumber);
	if (blockNumber === undefined || blockNumber <= 0n) {
		sendJson(response, 400, { error: "Missing blockNumber." });
		return;
	}

	if (typeof body.stateRoot === "string") {
		const stateRoot = body.stateRoot.trim();

		if (!stateRoot || /^0x0+$/i.test(stateRoot)) {
			sendJson(response, 400, { error: "stateRoot cannot be empty or zero." });
			return;
		}
	}

	try {
		const deployment = (
			await import("./env.ts")
		).readFrontendDeploymentConfig();
		const chainId = body.chainId ?? deployment.chainId ?? 31337;
		const creditPolicyAddress = resolveConfiguredCreditPolicyAddress(
			body.creditPolicyAddress,
		);

		// REPURPOSED: Prepare args for frontend to call AxiomV3Relayer.request
		const result = await prepareAxiomRequestArgs({
			userAddress: tryGetAddress(body.userAddress, "userAddress"),
			blockNumber,
			chainId,
			...(body.rpcUrl ? { rpcUrl: body.rpcUrl } : {}),
			creditPolicyAddress,
			...(body.axiomV2QueryAddress
				? { axiomV2QueryAddress: body.axiomV2QueryAddress }
				: {}),
		});

		sendJson(response, 200, {
			...result,
			blockNumber: blockNumber.toString(),
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to request Axiom root.";
		sendJson(response, 400, { error: message });
	}
}

async function handleRelayAxiomRequest(
	body: RelayAxiomRequestBody | undefined,
	response: ServerResponse,
) {
	if (!body || typeof body !== "object") {
		sendJson(response, 400, { error: "Invalid JSON body" });
		return;
	}

	const requiredFields: Array<keyof RelayAxiomRequestBody> = [
		"sourceChainId",
		"dataQueryHash",
		"computeQuery",
		"blockNumber",
		"feeData",
		"userSalt",
		"refundee",
		"dataQuery",
		"value",
	];
	for (const field of requiredFields) {
		if (body[field] === undefined || body[field] === null) {
			sendJson(response, 400, { error: `Missing ${String(field)}.` });
			return;
		}
	}

	if (!body.userAddress) {
		sendJson(response, 400, { error: "Missing userAddress." });
		return;
	}

	if (!body.creditVerifierAddress) {
		sendJson(response, 400, { error: "Missing creditVerifierAddress." });
		return;
	}

	try {
		const escrowClient = createPublicClient({
			chain: resolveRuntimeRpcChain(resolveTransactionRpcUrl()),
			transport: http(resolveTransactionRpcUrl(), { timeout: 300000 }),
		});
		const escrowBalance = (await escrowClient.readContract({
			address: getAddress(body.creditVerifierAddress) as Hex,
			abi: [
				{
					inputs: [
						{ internalType: "address", name: "user", type: "address" },
						{ internalType: "uint256", name: "blockNumber", type: "uint256" },
					],
					name: "deposits",
					outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
					stateMutability: "view",
					type: "function",
				},
			] as const,
			functionName: "deposits",
			args: [
				getAddress(body.userAddress),
				BigInt(body.blockNumber as string | number | bigint),
			],
		})) as bigint;

		console.log("[relay-axiom] escrow balance check", {
			userAddress: body.userAddress,
			blockNumber: body.blockNumber,
			escrowBalance: escrowBalance.toString(),
		});

		const requiredEscrow =
			BigInt(body.value as string | number | bigint) > 100000000000000000n
				? BigInt(body.value as string | number | bigint)
				: 100000000000000000n;

		if (escrowBalance < requiredEscrow) {
			sendJson(response, 400, {
				error: `Insufficient escrow. Required ${requiredEscrow.toString()}, have ${escrowBalance.toString()}.`,
			});
			return;
		}

		console.log("[relay-axiom] escrow passed", {
			userAddress: body.userAddress,
			blockNumber: body.blockNumber,
			requiredEscrow: requiredEscrow.toString(),
		});

		const result = await relayAxiomRequest({
			userAddress: body.userAddress,
			sourceChainId: body.sourceChainId as string | number | bigint,
			dataQueryHash: body.dataQueryHash as Hex,
			computeQuery: {
				k: body.computeQuery?.k ?? 0,
				resultLen: body.computeQuery?.resultLen ?? 0,
				vkey: (body.computeQuery?.vkey ?? []) as Hex[],
				computeProof: (body.computeQuery?.computeProof ?? "0x") as Hex,
			},
			blockNumber: body.blockNumber as string | number | bigint,
			feeData: {
				maxFeePerGas: body.feeData?.maxFeePerGas ?? 0,
				callbackGasLimit: body.feeData?.callbackGasLimit ?? 0,
				overrideAxiomQueryFee: body.feeData?.overrideAxiomQueryFee ?? 0,
			},
			userSalt: body.userSalt as Hex,
			refundee: body.refundee as string,
			dataQuery: body.dataQuery as Hex,
			value: body.value as string | number | bigint,
			...(body.creditPolicyAddress
				? { creditPolicyAddress: body.creditPolicyAddress }
				: {}),
			...(body.creditVerifierAddress
				? { creditVerifierAddress: body.creditVerifierAddress }
				: {}),
			...(body.rpcUrl ? { rpcUrl: body.rpcUrl } : {}),
		});

		sendJson(response, 200, {
			txHash: result.txHash,
			queryId: result.queryId.toString(),
			creditPolicyAddress: result.creditPolicyAddress,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to relay Axiom request.";
		sendJson(response, 400, { error: message });
	}
}

async function handleGenerateLoanProof(
	parsedBody: GenerateLoanProofRequest | undefined,
	response: ServerResponse,
) {
	if (!parsedBody || typeof parsedBody !== "object") {
		sendJson(response, 400, { error: "Invalid JSON body" });
		return;
	}

	if (!parsedBody.userAddress) {
		sendJson(response, 400, { error: "Missing userAddress." });
		return;
	}

	const blockNumber = parseBigIntValue(parsedBody.blockNumber);
	if (blockNumber === undefined || blockNumber <= 0n) {
		sendJson(response, 400, { error: "Missing blockNumber." });
		return;
	}

	try {
		const job = await proofQueue.add("generate-loan-proof", {
			userAddress: tryGetAddress(parsedBody.userAddress, "userAddress"),
			blockNumber: blockNumber.toString(),
			chainId: parsedBody.chainId,
			nonce: parsedBody.nonce,
			rpcUrl: parsedBody.rpcUrl,
			creditPolicyAddress: parsedBody.creditPolicyAddress,
		});

		sendJson(response, 202, {
			status: "pending",
			jobId: job.id,
			message: "Proof generation started in the background.",
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to enqueue proof job.";
		sendJson(response, 500, { error: message });
	}
}

async function handleGetProofStatus(jobId: string, response: ServerResponse) {
	try {
		const job = await proofQueue.getJob(jobId);

		if (!job) {
			sendJson(response, 404, { error: "Job not found" });
			return;
		}

		const state = await job.getState();

		if (state === "completed") {
			sendJson(response, 200, { status: "completed", result: job.returnvalue });
		} else if (state === "failed") {
			sendJson(response, 500, { status: "failed", error: job.failedReason });
		} else {
			sendJson(response, 200, { status: state });
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to fetch job status.";
		sendJson(response, 500, { error: message });
	}
}

async function handleGetProofData(
	request: IncomingMessage,
	response: ServerResponse,
	parsedBody?: Partial<ProofDataRequest>,
) {
	const url = new URL(request.url ?? "/api/get-proof-data", "http://localhost");
	const body: Partial<ProofDataRequest> = parsedBody ? { ...parsedBody } : {};

	if (request.method === "GET") {
		const userAddress = url.searchParams.get("userAddress") ?? undefined;
		const contractAddress =
			url.searchParams.get("contractAddress") ?? undefined;
		const chainId = parseNumber(url.searchParams.get("chainId") ?? undefined);
		const nonce = parseNumber(url.searchParams.get("nonce") ?? undefined);

		if (userAddress) {
			body.userAddress = userAddress;
		}

		if (contractAddress) {
			body.contractAddress = contractAddress;
		}

		if (chainId !== undefined) {
			const deployment = (
				await import("./env.ts")
			).readFrontendDeploymentConfig();
			body.chainId = deployment.chainId ?? 31337;
		}

		const rpcUrl = url.searchParams.get("rpcUrl") ?? undefined;
		if (rpcUrl) {
			body.rpcUrl = rpcUrl;
		}
	} else {
		if (!parsedBody) {
			sendJson(response, 400, { error: "Invalid JSON body" });
			return;
		}
	}

	const overrides =
		body.overrides && typeof body.overrides === "object"
			? { ...body.overrides }
			: undefined;

	if (!body.userAddress) {
		sendJson(response, 400, { error: "Missing userAddress." });
		return;
	}

	try {
		const deployment = (
			await import("./env.ts")
		).readFrontendDeploymentConfig();
		const contractAddress = tryGetAddress(
			body.contractAddress,
			"contractAddress",
		);
		const chainId = body.chainId ?? deployment.chainId ?? 31337;
		const nonce = body.nonce ?? Math.floor(Date.now() / 1000) >>> 0;

		const proofData = await getUserFeaturesAndSignature(
			tryGetAddress(body.userAddress, "userAddress"),
			contractAddress,
			chainId,
			nonce,
			body.rpcUrl ?? resolveTransactionRpcUrl(),
			overrides,
		);

		sendJson(response, 200, proofData);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid request.";
		sendJson(response, 400, { error: message });
	}
}

/**
 * @deprecated This endpoint is for debugging only.
 * The primary flow should now use the user's connected wallet to sign and submit scores.
 */
async function handleSubmitScore(
	parsedBody: SubmitScoreRequest | undefined,
	response: ServerResponse,
) {
	if (!parsedBody || typeof parsedBody !== "object") {
		sendJson(response, 400, { error: "Invalid JSON body" });
		return;
	}

	if (!parsedBody.userAddress) {
		sendJson(response, 400, { error: "Missing userAddress." });
		return;
	}

	if (parsedBody.score === undefined || Number.isNaN(parsedBody.score)) {
		sendJson(response, 400, { error: "Missing score." });
		return;
	}

	try {
		const scoreRegistryAddress = resolveScoreRegistryAddress(
			parsedBody.scoreRegistryAddress,
		);
		const privateKey = process.env.AGENT_PRIVATE_KEY;
		if (!privateKey) {
			throw new Error("AGENT_PRIVATE_KEY not configured on server.");
		}
		const account = privateKeyToAccount(privateKey as Hex);
		const rpcUrl = resolveTransactionRpcUrl();
		const publicClient = createPublicClient({
			chain: resolveRuntimeRpcChain(rpcUrl),
			transport: http(rpcUrl, { timeout: 300000 }),
		});
		const rpcChain = resolveRuntimeRpcChain(rpcUrl);
		const walletClient = createWalletClient({
			account,
			chain: rpcChain,
			transport: http(rpcUrl, { timeout: 300000 }),
		});

		const txHash = await walletClient.writeContract({
			address: scoreRegistryAddress,
			abi: scoreRegistryAbi,
			functionName: "setScore",
			args: [
				tryGetAddress(parsedBody.userAddress, "userAddress"),
				Math.max(0, Math.floor(parsedBody.score)),
			],
		});

		await publicClient.waitForTransactionReceipt({ hash: txHash });

		sendJson(response, 200, { txHash });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid request.";
		sendJson(response, 400, { error: message });
	}
}

/**
 * @deprecated This endpoint is for debugging only.
 * The primary flow should now use the user's connected wallet to sign and submit scores.
 */
async function handleRegisterScore(
	parsedBody: RegisterScoreRequest | undefined,
	response: ServerResponse,
) {
	if (!parsedBody || typeof parsedBody !== "object") {
		sendJson(response, 400, { error: "Invalid JSON body" });
		return;
	}

	const requiredFields: Array<keyof RegisterScoreRequest> = [
		"proof",
		"commitment",
		"score",
		"isSolvent",
		"proofHash",
		"nonce",
		"userAddress",
		"stateRoot",
		"blockNumber",
	];
	for (const field of requiredFields) {
		if (parsedBody[field] === undefined || parsedBody[field] === null) {
			sendJson(response, 400, { error: `Missing ${String(field)}.` });
			return;
		}
	}

	try {
		const creditPolicyAddress = resolveCreditPolicyAddress(
			parsedBody.creditPolicyAddress,
		);
		const proof = parsedBody.proof as Hex;
		const commitment = parsedBody.commitment as Hex;
		const score = Math.max(0, Math.floor(parsedBody.score as number));
		const isSolvent = Boolean(parsedBody.isSolvent);
		const proofHash = parsedBody.proofHash as Hex;
		const nonce = Math.max(0, Math.floor(parsedBody.nonce as number));
		const userAddress = tryGetAddress(parsedBody.userAddress, "userAddress");
		const stateRoot = parsedBody.stateRoot as Hex;
		const blockNumber = BigInt(
			parsedBody.blockNumber as string | number | bigint,
		);

		const privateKey = process.env.AGENT_PRIVATE_KEY;
		if (!privateKey) {
			throw new Error("AGENT_PRIVATE_KEY not configured on server.");
		}
		const account = privateKeyToAccount(privateKey as Hex);
		const rpcUrl = resolveTransactionRpcUrl();
		const publicClient = createPublicClient({
			chain: resolveRuntimeRpcChain(rpcUrl),
			transport: http(rpcUrl, { timeout: 300000 }),
		});
		const rpcChain = resolveRuntimeRpcChain(rpcUrl);
		const walletClient = createWalletClient({
			account,
			chain: rpcChain,
			transport: http(rpcUrl, { timeout: 300000 }),
		});

		const { request } = await publicClient.simulateContract({
			address: creditPolicyAddress,
			abi: creditPolicyAbi,
			functionName: "verifyAndRegisterScore",
			args: [
				proof,
				commitment,
				score,
				isSolvent,
				proofHash,
				nonce,
				userAddress,
				stateRoot,
				blockNumber,
			],
			account,
		});

		console.log("[register-score] verification payload", {
			creditPolicyAddress,
			userAddress,
			blockNumber: blockNumber.toString(),
			stateRoot,
			proofHash,
			commitment,
			score,
			isSolvent,
			nonce,
		});

		const txHash = await walletClient.writeContract({
			...request,
			account,
		});

		await publicClient.waitForTransactionReceipt({ hash: txHash });

		console.log("✅ Score successfully registered for user:", userAddress);

		sendJson(response, 200, { txHash });
	} catch (error) {
		console.error("[register-score] backend error:", error);
		console.error(
			"[register-score] revert details:",
			formatRevertDetails(error, creditPolicyAbi),
		);
		const message = error instanceof Error ? error.message : "Invalid request.";
		sendJson(response, 400, { error: message });
	}
}

async function handleRelayScoreRegistration(
	parsedBody: RegisterScoreRequest | undefined,
	response: ServerResponse,
) {
	await handleRegisterScore(parsedBody, response);
}

async function handleGenerateProof(
	parsedBody: GenerateProofRequest | undefined,
	response: ServerResponse,
) {
	if (!parsedBody || typeof parsedBody !== "object") {
		sendJson(response, 400, { error: "Invalid JSON body" });
		return;
	}

	if (!parsedBody.inputs || typeof parsedBody.inputs !== "object") {
		sendJson(response, 400, { error: "Missing inputs." });
		return;
	}

	try {
		const circuitName =
			parsedBody.circuitName === "account" ||
			parsedBody.circuitName === "storage" ||
			parsedBody.circuitName === "combined"
				? parsedBody.circuitName
				: "combined";
		const { metadata: _metadata, ...witnessInputs } = parsedBody.inputs as {
			metadata?: unknown;
		} & Record<string, unknown>;
		const proofData = await generateBackendProof(circuitName, witnessInputs);

		sendJson(response, 200, proofData);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Proof generation failed.";
		sendJson(response, 400, { error: message });
	}
}

export function startApiServer(port = resolveBackendPort()) {
	const server = createServer((request, response) => {
		setCorsHeaders(response);

		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}

		const traceId = (request.headers["x-trace-id"] as string) || crypto.randomUUID();
		response.setHeader("x-trace-id", traceId);

		const startTime = process.hrtime();
		const requestUrl = new URL(request.url ?? "/", "http://localhost");
		const routePath = normalizeRoutePath(requestUrl.pathname);

		response.on("finish", () => {
			const diff = process.hrtime(startTime);
			const durationSeconds = diff[0] + diff[1] / 1e9;
			const status = response.statusCode.toString();
			httpRequestsTotal.inc({ method: request.method || "GET", route: routePath, status });
			httpRequestDurationSeconds.observe(
				{ method: request.method || "GET", route: routePath, status },
				durationSeconds,
			);
		});

		void runWithContext({ traceId, spanId: crypto.randomUUID().slice(0, 8) }, async () => {
			try {
				let parsedBody: unknown;
				if (request.method === "POST" && parsedBody === undefined) {
					sendJson(response, 400, { error: "Invalid JSON body" });
					return;
				}

			if (
				routePath === "/get-proof-data" &&
				(request.method === "GET" || request.method === "POST")
			) {
				await handleGetProofData(
					request,
					response,
					parsedBody as Partial<ProofDataRequest> | undefined,
				);
				return;
			}

			if (routePath === "/generate-proof" && request.method === "POST") {
				await handleGenerateProof(parsedBody as GenerateProofRequest, response);
				return;
			}

			if (routePath === "/submit-score" && request.method === "POST") {
				await handleSubmitScore(parsedBody as SubmitScoreRequest, response);
				return;
			}

			if (routePath === "/metrics" && request.method === "GET") {
				response.setHeader("Content-Type", "text/plain; version=0.0.4");
				response.end(await getMetrics());
				return;
			}

			if (routePath === "/register-score" && request.method === "POST") {
				await handleRegisterScore(parsedBody as RegisterScoreRequest, response);
				return;
			}

			if (
				routePath === "/relay-score-registration" &&
				request.method === "POST"
			) {
				await handleRelayScoreRegistration(
					parsedBody as RegisterScoreRequest,
					response,
				);
				return;
			}

			if (routePath === "/request-axiom-root" && request.method === "POST") {
				await handleRequestAxiomRoot(
					parsedBody as RequestAxiomRootRequest,
					response,
				);
				return;
			}

			if (routePath === "/relay-axiom-request" && request.method === "POST") {
				await handleRelayAxiomRequest(
					parsedBody as RelayAxiomRequestBody,
					response,
				);
				return;
			}

			if (routePath === "/generate-loan-proof" && request.method === "POST") {
				await handleGenerateLoanProof(
					parsedBody as GenerateLoanProofRequest,
					response,
				);
				return;
			}

			if (routePath.startsWith("/proof-status/") && request.method === "GET") {
				const jobId = routePath.split("/").pop() || "";
				await handleGetProofStatus(jobId, response);
				return;
			}

			if (routePath === "/health") {
				sendJson(response, 200, { ok: true, timestamp: new Date().toISOString() });
				return;
			}

			sendJson(response, 404, { error: "Not found." });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Server error";
			dispatchAlert({
				severity: "critical",
				category: "rpc_error",
				title: "API Unhandled Server Error",
				message,
				metadata: { routePath },
			});
			sendJson(response, 500, { error: message });
		}
	});
});

	server.listen(port, () => {
		console.log(`Backend API listening on http://127.0.0.1:${port}`);
		try {
			const callbackTarget = resolveConfiguredCreditPolicyAddress();
			void startAxiomRelayer({
				callbackTarget,
			}).catch((error) => {
				console.error("[relayer] Critical failure:", error);
			});
		} catch (error) {
			console.warn(
				"[relayer] Contract not deployed yet (CREDIT_POLICY_ADDRESS missing). Relayer standing by until deployment.",
			);
		}
	});

	return server;
}

async function main() {
	startApiServer();
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
