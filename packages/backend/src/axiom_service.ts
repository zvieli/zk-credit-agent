import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSendQuery, getAxiomV2QueryAddress } from "@axiom-crypto/client";
import { DataSubqueryType, HeaderField } from "@axiom-crypto/tools";
import dotenv from "dotenv";
import {
	type Chain,
	createPublicClient,
	createWalletClient,
	decodeEventLog,
	encodeAbiParameters,
	getAddress,
	http,
	parseAbiParameters,
	parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
	buildLoanProofInputs,
	type GeneratedProof,
	generateProof as generateCircuitProof,
	type LoanProofInputs,
	type ProofCircuitName,
	toLoanProofWitnessInputs,
	writeLoanProofToml,
} from "./prover.ts";

export async function generateProof(
	circuitName: ProofCircuitName,
	inputs: Record<string, unknown>,
): Promise<GeneratedProof> {
	return generateCircuitProof(circuitName, inputs);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

type Hex = `0x${string}`;

const OFFICIAL_MAINNET_AXIOM_V2_QUERY_ADDRESS =
	"0x386121D50d8591873C8b8b15d666E3A3705978f8" as Hex;
const MAINNET_CHAIN_ID = 1;

type DeploymentConfig = {
	chainId?: number;
	rpcUrl?: string;
	proofRpcUrl?: string;
	creditPolicyAddress?: string;
	axiomV2QueryAddress?: string;
};

type RequestAxiomRootParams = {
	userAddress: string;
	blockNumber: bigint;
	chainId?: number | undefined;
	rpcUrl?: string | undefined;
	creditPolicyAddress?: string | undefined;
	axiomV2QueryAddress?: string | undefined;
};

type RelayAxiomRequestParams = {
	userAddress: string;
	sourceChainId: string | number | bigint;
	dataQueryHash: Hex;
	computeQuery: {
		k: number;
		resultLen: number;
		vkey: Hex[];
		computeProof: Hex;
	};
	blockNumber: string | number | bigint;
	feeData: {
		maxFeePerGas: string | number | bigint;
		callbackGasLimit: number;
		overrideAxiomQueryFee: string | number | bigint;
	};
	userSalt: Hex;
	refundee: string;
	dataQuery: Hex;
	value: string | number | bigint;
	creditPolicyAddress?: string | undefined;
	creditVerifierAddress?: string | undefined;
	rpcUrl?: string | undefined;
};

type GenerateLoanProofParams = {
	userAddress: string;
	blockNumber: bigint;
	nonce?: number | undefined;
	chainId?: number | undefined;
	rpcUrl?: string | undefined;
	creditPolicyAddress?: string | undefined;
};

type AxiomRequestResult = {
	txHash: Hex;
	queryId: bigint;
	queryHash: Hex;
	userAddress: Hex;
	blockNumber: bigint;
	creditPolicyAddress: Hex;
	axiomV2QueryAddress: Hex;
};

type VerifiedRootResult = {
	blockNumber: bigint;
	stateRoot: Hex;
	creditPolicyAddress: Hex;
};

const AXIOM_QUERY_EVENT_ABI = [
	{
		type: "event",
		name: "QueryInitiatedOnchain",
		anonymous: false,
		inputs: [
			{ name: "caller", type: "address", indexed: true },
			{ name: "queryHash", type: "bytes32", indexed: true },
			{ name: "queryId", type: "uint256", indexed: true },
			{ name: "userSalt", type: "bytes32", indexed: false },
			{ name: "refundee", type: "address", indexed: false },
			{ name: "target", type: "address", indexed: false },
			{ name: "extraData", type: "bytes", indexed: false },
		],
	},
] as const;

const AXIOM_QUERY_INITIATED_TOPIC0_PREFIX = "0xb72b05c0";

const creditPolicyAbi = [
	{
		inputs: [{ internalType: "uint256", name: "blockNumber", type: "uint256" }],
		name: "verifiedRoots",
		outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

function readDeploymentConfig(): DeploymentConfig {
	const deploymentPath = path.resolve(
		__dirname,
		"../../frontend/public/deployment.json",
	);

	if (!existsSync(deploymentPath)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentConfig;
	} catch {
		return {};
	}
}

function resolveTransactionRpcUrl(explicitRpcUrl?: string) {
	if (explicitRpcUrl) {
		return explicitRpcUrl;
	}

	if (process.env.ANVIL_RPC_URL) {
		return process.env.ANVIL_RPC_URL;
	}

	if (process.env.RPC_URL) {
		return process.env.RPC_URL;
	}

	if (process.env.TX_RPC_URL) {
		return process.env.TX_RPC_URL;
	}

	const deployment = readDeploymentConfig();
	if (deployment.rpcUrl) {
		return deployment.rpcUrl;
	}

	return "http://127.0.0.1:8545";
}

function resolveProofRpcUrl(explicitRpcUrl?: string) {
	if (explicitRpcUrl) {
		return explicitRpcUrl;
	}

	if (process.env.ANVIL_RPC_URL) {
		return process.env.ANVIL_RPC_URL;
	}

	if (process.env.PROOF_RPC_URL) {
		return process.env.PROOF_RPC_URL;
	}

	const deployment = readDeploymentConfig();
	if (deployment.proofRpcUrl) {
		return deployment.proofRpcUrl;
	}

	return resolveTransactionRpcUrl();
}

function resolveChainId(_explicitChainId?: number) {
	if (_explicitChainId) return _explicitChainId;
	const deployment = readDeploymentConfig();
	return deployment.chainId ?? 31337;
}

function resolveAgentPrivateKey() {
	const privateKey = process.env.AGENT_PRIVATE_KEY;

	if (!privateKey) {
		throw new Error("Missing AGENT_PRIVATE_KEY.");
	}

	return privateKey as Hex;
}

export function resolveCreditPolicyAddress(explicitAddress?: string) {
	const deployment = readDeploymentConfig();
	const resolvedAddress =
		explicitAddress ??
		process.env.CREDIT_POLICY_ADDRESS ??
		deployment.creditPolicyAddress;

	if (!resolvedAddress) {
		throw new Error("Missing CREDIT_POLICY_ADDRESS.");
	}

	return getAddress(resolvedAddress) as Hex;
}

function resolveAxiomV2QueryAddress(chainId: number, explicitAddress?: string) {
	const deployment = readDeploymentConfig();
	const resolvedAddress =
		explicitAddress ??
		process.env.AXIOM_V2_QUERY_ADDRESS ??
		deployment.axiomV2QueryAddress;

	if (resolvedAddress) {
		return getAddress(resolvedAddress) as Hex;
	}

	return getAddress(getAxiomV2QueryAddress(String(chainId))) as Hex;
}

function resolveRpcChain(chainId: number): Chain {
	const rpcUrl =
		process.env.ANVIL_RPC_URL ?? process.env.RPC_URL ?? "http://127.0.0.1:8545";

	return {
		...mainnet,
		id: chainId,
		rpcUrls: {
			default: { http: [rpcUrl] },
			public: { http: [rpcUrl] },
		},
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function encodeAxiomStateRootCallbackData(
	blockNumber: bigint,
	user = "0x0000000000000000000000000000000000000000",
	nonce = 0,
) {
	return encodeAbiParameters(
		parseAbiParameters("address, uint256, uint256"),
		[getAddress(user), blockNumber, BigInt(nonce)],
	);
}

export function buildHeaderStateRootQuery(blockNumber: bigint) {
	return [
		{
			type: DataSubqueryType.Header,
			subqueryData: {
				blockNumber: Number(blockNumber),
				fieldIdx: HeaderField.StateRoot,
			},
		},
	] as const;
}

export async function buildAndSendAxiomStateRootQuery(input: {
	chainId: number;
	rpcUrl: string;
	caller: string;
	callbackTarget: string;
	blockNumber: bigint;
	dataQuery: any[];
	computeQuery: any;
	options?: any;
	target?: { chainId: number; rpcUrl: string };
	axiomV2QueryAddress?: string;
	mock?: boolean;
	sendQuery?: (payload: any) => Promise<unknown>;
}) {
	const axiomV2QueryAddress =
		input.axiomV2QueryAddress ?? getAxiomV2QueryAddress(String(input.chainId));
	const sendQueryArgs = await buildSendQuery({
		chainId: "1", // Data source is Mainnet
		rpcUrl: input.rpcUrl,
		axiomV2QueryAddress,
		dataQuery: input.dataQuery,
		computeQuery: input.computeQuery,
		callback: {
			target: getAddress(input.callbackTarget),
			extraData: encodeAxiomStateRootCallbackData(input.blockNumber),
		},
		caller: getAddress(input.caller),
		mock: input.mock ?? true,
		options: input.options ?? {},
		target: input.target,
	} as any);

	if (input.sendQuery) {
		const txHash = await input.sendQuery(sendQueryArgs);
		return { ...sendQueryArgs, txHash };
	}

	return sendQueryArgs;
}

export async function requestAxiomRoot(
	params: RequestAxiomRootParams,
): Promise<AxiomRequestResult> {
	const chainId = resolveChainId(params.chainId);
	const txRpcUrl = resolveTransactionRpcUrl(params.rpcUrl);
	const proofRpcUrl = resolveProofRpcUrl();
	const account = privateKeyToAccount(resolveAgentPrivateKey());
	const rpcChain = resolveRpcChain(chainId);
	const publicClient = createPublicClient({
		chain: rpcChain,
		transport: http(txRpcUrl, { timeout: 300000 }),
	});
	const walletClient = createWalletClient({
		account,
		chain: rpcChain,
		transport: http(txRpcUrl, { timeout: 300000 }),
	});
	const creditPolicyAddress = resolveCreditPolicyAddress(
		params.creditPolicyAddress,
	);
	const axiomV2QueryAddress = resolveAxiomV2QueryAddress(
		chainId,
		params.axiomV2QueryAddress,
	);
	const validatedUserAddress = getAddress(params.userAddress) as Hex;

	console.log("[axiom] requestAxiomRoot resolved addresses", {
		chainId,
		creditPolicyAddress,
		axiomV2QueryAddress,
	});

	const sendQueryArgs = await buildSendQuery({
		chainId: "1", // Data source is Mainnet (Axiom contract requirement)
		rpcUrl: proofRpcUrl,
		axiomV2QueryAddress,
		dataQuery: buildHeaderStateRootQuery(
			params.blockNumber,
		) as unknown as any[],
		computeQuery: {
			k: 0,
			resultLen: 1,
			vkey: [],
			computeProof: "0x00",
		},
		callback: {
			target: creditPolicyAddress,
			extraData: encodeAxiomStateRootCallbackData(params.blockNumber, validatedUserAddress),
		},
		caller: account.address,
		mock: false,
		options: {},
	});

	const txHash = await walletClient.writeContract({
		address: sendQueryArgs.address as Hex,
		abi: sendQueryArgs.abi,
		functionName: sendQueryArgs.functionName,
		args: sendQueryArgs.args,
		value: sendQueryArgs.value,
	});

	const receiptPollIntervalMs = 2000;
	const receiptDeadlineMs = 30_000;
	const startedAt = Date.now();
	let queryEvent: { args: { queryId: bigint; queryHash: Hex } } | undefined;

	for (
		let attempt = 0;
		Date.now() - startedAt <= receiptDeadlineMs;
		attempt++
	) {
		let queryReceipt;

		try {
			queryReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
		} catch {
			queryReceipt = undefined;
		}

		if (queryReceipt) {
			console.log("[axiom] receipt raw logs", queryReceipt.logs);
			const queryLogs = parseEventLogs({
				abi: AXIOM_QUERY_EVENT_ABI,
				logs: queryReceipt.logs,
			});
			queryEvent = queryLogs.find(
				(log) => log.eventName === "QueryInitiatedOnchain",
			) as { args: { queryId: bigint; queryHash: Hex } } | undefined;

			if (!queryEvent) {
				const directQueryLog = queryReceipt.logs.find((log) =>
					log.topics[0]
						?.toLowerCase()
						.startsWith(AXIOM_QUERY_INITIATED_TOPIC0_PREFIX),
				);

				if (directQueryLog) {
					const decodedQueryLog = decodeEventLog({
						abi: AXIOM_QUERY_EVENT_ABI,
						data: directQueryLog.data,
						topics: directQueryLog.topics,
					});

					if (decodedQueryLog.eventName === "QueryInitiatedOnchain") {
						queryEvent = decodedQueryLog as {
							args: { queryId: bigint; queryHash: Hex };
						};
					}
				}
			}

			if (queryEvent) {
				console.log(
					"[axiom] Query detected! queryId:",
					queryEvent.args.queryId.toString(),
				);
			}

			if (queryEvent) {
				break;
			}
		}

		console.log(
			"[axiom] QueryInitiatedOnchain not found yet, retrying receipt scan",
			{
				attempt: attempt + 1,
				txHash,
				axiomV2QueryAddress,
				creditPolicyAddress,
			},
		);

		if (Date.now() - startedAt > receiptDeadlineMs) {
			break;
		}

		await sleep(receiptPollIntervalMs);
	}

	if (!queryEvent) {
		throw new Error(
			`Missing QueryInitiatedOnchain event from Axiom dispatch. Expected Axiom V2 Query address ${axiomV2QueryAddress}.`,
		);
	}

	return {
		txHash,
		queryId: queryEvent.args.queryId as bigint,
		queryHash: queryEvent.args.queryHash as Hex,
		userAddress: validatedUserAddress,
		blockNumber: params.blockNumber,
		creditPolicyAddress,
		axiomV2QueryAddress,
	};
}

export async function prepareAxiomRequestArgs(params: RequestAxiomRootParams) {
	const chainId = resolveChainId(params.chainId);
	const proofRpcUrl = resolveProofRpcUrl();
	const creditPolicyAddress = resolveCreditPolicyAddress(
		params.creditPolicyAddress,
	);
	const axiomV2QueryAddress = resolveAxiomV2QueryAddress(
		chainId,
		params.axiomV2QueryAddress,
	);

	const sendQueryArgs = await buildSendQuery({
		chainId: "1",
		rpcUrl: proofRpcUrl,
		axiomV2QueryAddress,
		dataQuery: buildHeaderStateRootQuery(
			params.blockNumber,
		) as unknown as any[],
		computeQuery: {
			k: 0,
			resultLen: 1,
			vkey: [],
			computeProof: "0x00",
		},
		callback: {
			target: creditPolicyAddress,
			extraData: encodeAxiomStateRootCallbackData(params.blockNumber, params.userAddress),
		},
		caller: creditPolicyAddress, // The Relayer contract will be the caller
		mock: false,
		options: {},
	});

	return {
		sourceChainId: sendQueryArgs.args[0],
		dataQueryHash: sendQueryArgs.args[1],
		computeQuery: sendQueryArgs.args[2],
		callback: sendQueryArgs.args[3],
		feeData: sendQueryArgs.args[4],
		userSalt: sendQueryArgs.args[5],
		refundee: sendQueryArgs.args[6],
		dataQuery: sendQueryArgs.args[7],
		axiomV2QueryAddress: sendQueryArgs.address,
		value: sendQueryArgs.value,
	};
}

export async function relayAxiomRequest(
	params: RelayAxiomRequestParams,
): Promise<{ txHash: Hex; queryId: bigint; creditPolicyAddress: Hex }> {
	const chainId = resolveChainId();
	const rpcUrl = resolveTransactionRpcUrl(params.rpcUrl);
	const account = privateKeyToAccount(resolveAgentPrivateKey());
	const rpcChain = resolveRpcChain(chainId);
	const publicClient = createPublicClient({
		chain: rpcChain,
		transport: http(rpcUrl, { timeout: 300000 }),
	});
	const walletClient = createWalletClient({
		account,
		chain: rpcChain,
		transport: http(rpcUrl, { timeout: 300000 }),
	});
	const creditPolicyAddress = resolveCreditPolicyAddress(
		params.creditPolicyAddress,
	);
	const creditVerifierAddress = params.creditVerifierAddress
		? getAddress(params.creditVerifierAddress)
		: undefined;
	const userAddress = getAddress(params.userAddress) as Hex;
	const blockNumber = BigInt(params.blockNumber);
	const totalPullAmount = BigInt(params.value);

	if (creditVerifierAddress) {
		const escrowBalance = (await publicClient.readContract({
			address: creditVerifierAddress,
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
			args: [userAddress, blockNumber],
		})) as bigint;

		const requiredEscrow =
			totalPullAmount > 100000000000000000n
				? totalPullAmount
				: 100000000000000000n;
		if (escrowBalance < requiredEscrow) {
			throw new Error(
				`Insufficient escrow balance. Required ${requiredEscrow.toString()}, have ${escrowBalance.toString()}.`,
			);
		}
	}

	const txHash = await walletClient.writeContract({
		address: creditPolicyAddress,
		abi: [
			{
				name: "request",
				type: "function",
				stateMutability: "payable",
				inputs: [
					{ name: "sourceChainId", type: "uint64" },
					{ name: "dataQueryHash", type: "bytes32" },
					{
						name: "computeQuery",
						type: "tuple",
						components: [
							{ name: "k", type: "uint8" },
							{ name: "resultLen", type: "uint16" },
							{ name: "vkey", type: "bytes32[]" },
							{ name: "computeProof", type: "bytes" },
						],
					},
					{ name: "user", type: "address" },
					{ name: "blockNumber", type: "uint256" },
					{
						name: "feeData",
						type: "tuple",
						components: [
							{ name: "maxFeePerGas", type: "uint64" },
							{ name: "callbackGasLimit", type: "uint32" },
							{ name: "overrideAxiomQueryFee", type: "uint256" },
						],
					},
					{ name: "userSalt", type: "bytes32" },
					{ name: "refundee", type: "address" },
					{ name: "dataQuery", type: "bytes" },
					{ name: "pullAmount", type: "uint256" },
				],
				outputs: [{ name: "queryId", type: "uint256" }],
			},
		] as const,
		functionName: "request",
		args: [
			BigInt(params.sourceChainId),
			params.dataQueryHash,
			params.computeQuery,
			userAddress,
			blockNumber,
			{
				maxFeePerGas: BigInt(params.feeData.maxFeePerGas),
				callbackGasLimit: params.feeData.callbackGasLimit,
				overrideAxiomQueryFee: BigInt(params.feeData.overrideAxiomQueryFee),
			},
			params.userSalt,
			getAddress(params.refundee),
			params.dataQuery,
			totalPullAmount,
		],
		value: 0n,
	});

	console.log("[relay-axiom] request submitted", {
		creditPolicyAddress,
		creditVerifierAddress: creditVerifierAddress ?? null,
		userAddress,
		blockNumber: blockNumber.toString(),
		totalPullAmount: totalPullAmount.toString(),
		txHash,
	});

	const receipt = await publicClient.waitForTransactionReceipt({
		hash: txHash,
	});
	console.log("[relay-axiom] request mined", {
		txHash,
		status: receipt.status,
		blockNumber: receipt.blockNumber.toString(),
	});
	const queryLogs = parseEventLogs({
		abi: AXIOM_QUERY_EVENT_ABI,
		logs: receipt.logs,
	});
	const queryEvent = queryLogs.find(
		(log) => log.eventName === "QueryInitiatedOnchain",
	) as { args: { queryId: bigint } } | undefined;

	if (!queryEvent) {
		throw new Error(
			"Missing QueryInitiatedOnchain event from relayed Axiom request.",
		);
	}

	return {
		txHash,
		queryId: queryEvent.args.queryId,
		creditPolicyAddress,
	};
}

export async function readVerifiedRoot(params: {
	blockNumber: bigint;
	creditPolicyAddress?: string | undefined;
	rpcUrl?: string | undefined;
	chainId?: number | undefined;
}): Promise<VerifiedRootResult | null> {
	const chainId = resolveChainId(params.chainId);
	const rpcUrl = resolveProofRpcUrl(params.rpcUrl);
	const publicClient = createPublicClient({
		chain: resolveRpcChain(chainId),
		transport: http(rpcUrl, { timeout: 300000 }),
	});
	const deployment = readDeploymentConfig();
	const axiomV3RelayerAddress = getAddress(deployment.axiomV3RelayerAddress!);
	const creditPolicyAddress = resolveCreditPolicyAddress(
		params.creditPolicyAddress,
	);

	const stateRoot = (await publicClient.readContract({
		address: axiomV3RelayerAddress,
		abi: creditPolicyAbi,
		functionName: "verifiedRoots",
		args: [params.blockNumber],
	})) as Hex;

	if (
		!stateRoot ||
		stateRoot ===
			"0x0000000000000000000000000000000000000000000000000000000000000000"
	) {
		return null;
	}

	return {
		blockNumber: params.blockNumber,
		stateRoot,
		creditPolicyAddress,
	};
}

export async function generateLoanProof(
	params: GenerateLoanProofParams,
): Promise<
	GeneratedProof &
		VerifiedRootResult & { metadata: LoanProofInputs["metadata"] }
> {
	const chainId = resolveChainId(params.chainId);
	const rpcUrl = resolveProofRpcUrl(params.rpcUrl);
	const nonce = params.nonce ?? Math.floor(Date.now() / 1000) >>> 0;
	const verifiedRoot = await readVerifiedRoot({
		blockNumber: params.blockNumber,
		...(params.creditPolicyAddress
			? { creditPolicyAddress: params.creditPolicyAddress }
			: {}),
		rpcUrl,
		chainId,
	});

	if (!verifiedRoot) {
		throw new Error(
			`State root for block ${params.blockNumber.toString()} is not verified on-chain.`,
		);
	}

	const proofInputs = await buildLoanProofInputs({
		userAddress: params.userAddress,
		contractAddress: verifiedRoot.creditPolicyAddress,
		nonce,
		chainId,
		rpcUrl,
		provenanceOverrides: {
			blockNumber: params.blockNumber,
			stateRoot: verifiedRoot.stateRoot,
		},
	});

	const combinedProverTomlPath = path.resolve(
		__dirname,
		"../../circuit/combined/Prover.toml",
	);
	writeLoanProofToml(
		combinedProverTomlPath,
		toLoanProofWitnessInputs(proofInputs),
	);

	const generatedProof = await generateCircuitProof("combined", proofInputs);

	return {
		...generatedProof,
		...verifiedRoot,
		metadata: proofInputs.metadata,
	};
}
