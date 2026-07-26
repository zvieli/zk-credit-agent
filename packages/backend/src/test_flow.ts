import { buildSendQuery, getAxiomV2QueryAddress } from "@axiom-crypto/client";
import { DataSubqueryType, HeaderField } from "@axiom-crypto/tools";
import * as dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
	createPublicClient,
	createWalletClient,
	encodeAbiParameters,
	getAddress,
	getContractAddress,
	http,
	keccak256,
	parseAbiParameters,
	parseEther,
	parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
	encodeAxiomStateRootCallbackData,
	getUserFeaturesAndSignature,
} from "./index.ts";
import {
	buildLoanProofInputs,
	generateProof,
	regenerateCombinedVerifierArtifacts,
	toLoanProofWitnessInputs,
	writeLoanProofToml,
} from "./prover.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });
const CONTRACTS_OUT = resolve(__dirname, "../../contracts/out");
const COMBINED_PROOF_FIXTURE = resolve(
	__dirname,
	"../../contracts/test/data/combined_proof.hex",
);
const COMBINED_VERIFIER_ARTIFACT = join(
	CONTRACTS_OUT,
	"combined_verifier.sol/HonkVerifier.json",
);
const TRANSCRIPT_LIB_ARTIFACT_CANDIDATES = [
	join(CONTRACTS_OUT, "combined_verifier.sol/ZKTranscriptLib.json"),
	join(CONTRACTS_OUT, "account_verifier.sol/ZKTranscriptLib.json"),
	join(CONTRACTS_OUT, "storage_verifier.sol/ZKTranscriptLib.json"),
];
const SCORE_REGISTRY_ARTIFACT = join(
	CONTRACTS_OUT,
	"ScoreRegistry.sol/ScoreRegistry.json",
);
const LOCAL_DEV_FUND_WEI = "0x3635c9adc5dea00000";

function encodeAxiomStateRootCallbackDataFull(
	blockNumber: bigint,
	user: `0x${string}`,
	nonce: bigint,
) {
	return encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [
		user,
		blockNumber,
		nonce,
	]);
}

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

function loadVerifierArtifact(filePath: string) {
	return JSON.parse(readFileSync(filePath, "utf-8"));
}

function loadTranscriptLibArtifact() {
	for (const artifactPath of TRANSCRIPT_LIB_ARTIFACT_CANDIDATES) {
		try {
			return JSON.parse(readFileSync(artifactPath, "utf-8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
		}
	}

	throw new Error(
		`Missing ZKTranscriptLib artifact. Looked in: ${TRANSCRIPT_LIB_ARTIFACT_CANDIDATES.join(", ")}`,
	);
}

function buildHeaderStateRootQuery(blockNumber: bigint) {
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

async function dispatchAxiomHeaderQuery(input: {
	publicClient: any;
	walletClient: any;
	creditPolicyAbi: any;
	axiomV2QueryAddress: `0x${string}`;
	caller: `0x${string}`;
	callbackTarget: `0x${string}`;
	blockNumber: bigint;
	stateRoot: `0x${string}`;
	chainId: number;
	rpcUrl: string;
	chain: any;
}) {
	console.log(
		`Requesting provenance for block ${input.blockNumber} via Relayer ${input.callbackTarget}...`,
	);

	const dataQuery = encodeAbiParameters(
		[
			{
				type: "tuple[]",
				components: [
					{ name: "type", type: "uint8" },
					{ name: "subqueryData", type: "bytes" },
				],
			},
		],
		[
			[
				{
					type: 0, // Header
					subqueryData: encodeAbiParameters(
						parseAbiParameters("uint32, uint8"),
						[Number(input.blockNumber), 3], // 3 = StateRoot
					),
				},
			],
		],
	);

	const nonce = await input.publicClient.readContract({
		address: input.callbackTarget,
		abi: input.creditPolicyAbi,
		functionName: "nextNonce",
	});

	const queryTxHash = await input.walletClient.writeContract({
		address: input.callbackTarget,
		abi: input.creditPolicyAbi,
		functionName: "request",
		args: [
			BigInt(input.chainId),
			keccak256(dataQuery),
			{ k: 0, resultLen: 1, vkey: [], computeProof: "0x00" },
			input.blockNumber,
			{
				maxFeePerGas: 100000000000n,
				callbackGasLimit: 1000000,
				overrideAxiomQueryFee: 0n,
			},
			`0x${"00".repeat(32)}`,
			input.caller,
			dataQuery,
		],
		value: parseEther("0.1"),
	});

	const queryReceipt = await input.publicClient.waitForTransactionReceipt({
		hash: queryTxHash,
	});
	const queryLogs = parseEventLogs({
		abi: input.creditPolicyAbi,
		logs: queryReceipt.logs,
	});
	const queryEvent = queryLogs.find(
		(log) => log.eventName === "QueryRequested",
	);

	if (!queryEvent) {
		throw new Error("Missing QueryRequested event from Relayer");
	}

	const queryId = queryEvent.args.queryId;
	console.log(`Axiom query dispatched via Relayer: ${queryId.toString()}`);

	await input.publicClient.request({
		method: "anvil_impersonateAccount",
		params: [input.axiomV2QueryAddress],
	} as any);

	const TEST_FUND_HEX = "0x21e19e0c9bab2400000"; // 10000 ETH
	await input.publicClient.request({
		method: "anvil_setBalance",
		params: [input.axiomV2QueryAddress, TEST_FUND_HEX],
	} as any);

	const axiomWalletClient = createWalletClient({
		account: input.axiomV2QueryAddress,
		chain: input.chain,
		transport: http(input.rpcUrl, { timeout: 300000 }),
	});

	console.log("Relaying Axiom callback...");
	const callbackHash = await axiomWalletClient.writeContract({
		address: input.callbackTarget,
		abi: input.creditPolicyAbi,
		functionName: "axiomV2Callback",
		args: [
			BigInt(input.chainId),
			input.callbackTarget,
			`0x${"00".repeat(32)}` as `0x${string}`,
			[input.stateRoot],
			encodeAxiomStateRootCallbackDataFull(
				input.blockNumber,
				input.caller,
				BigInt(nonce),
			),
		],
		account: input.axiomV2QueryAddress,
		maxFeePerGas: 100000000000n,
		maxPriorityFeePerGas: 100000000000n,
		gas: 1000000n,
	});

	const callbackReceipt = await input.publicClient.waitForTransactionReceipt({
		hash: callbackHash,
	});
	const callbackLogs = parseEventLogs({
		abi: input.creditPolicyAbi,
		logs: callbackReceipt.logs,
	});
	const consumed = callbackLogs.find(
		(log: any) => log.eventName === "AxiomResultsConsumed",
	);

	if (!consumed) {
		throw new Error("Missing AxiomResultsConsumed event after local relay");
	}

	console.log(
		`Axiom callback relayed for block ${input.blockNumber.toString()}`,
	);
}

function linkLibraryBytecode(
	bytecode: string,
	linkReferences: Record<
		string,
		Record<string, Array<{ start: number; length: number }>>
	>,
	libraryName: string,
	libraryAddress: string,
) {
	let linkedBytecode = bytecode;

	for (const referencesByLibrary of Object.values(linkReferences)) {
		const references = referencesByLibrary[libraryName];
		if (!references) {
			continue;
		}

		for (const reference of references) {
			const startHex = reference.start * 2 + 2;
			const lengthHex = reference.length * 2;
			linkedBytecode =
				linkedBytecode.substring(0, startHex) +
				libraryAddress.slice(2).toLowerCase() +
				linkedBytecode.substring(startHex + lengthHex);
		}
	}

	if (linkedBytecode.includes("__$")) {
		throw new Error(
			`Unresolved library placeholders remain in ${libraryName} bytecode.`,
		);
	}

	return linkedBytecode as `0x${string}`;
}

async function main() {
	const privateKey = (process.env.AGENT_PRIVATE_KEY ||
		"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
	const account = privateKeyToAccount(privateKey);
	const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
	const proofRpcUrl =
		process.env.PROOF_RPC_URL ||
		process.env.anvil_RPC_URL ||
		(process.env.ALCHEMY_API_KEY
			? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
			: "https://eth.drpc.org");
	const transport = http(rpcUrl, {
		timeout: 300000,
	});
	const borrowerAddress = getAddress(
		process.env.ADDR || "0x4a4E5DF4874e405912b3cAb2cD18B889ad4bE220",
	);
	process.env.PROOF_RPC_URL = proofRpcUrl;
	console.log(`Using proof RPC: ${proofRpcUrl}`);

	const anvil = {
		...mainnet,
		id: 31337,
	};
	const chain =
		rpcUrl.includes("127.0.0.1") ||
		rpcUrl.includes("localhost") ||
		rpcUrl.includes("anvil") ||
		rpcUrl.includes("8545")
			? anvil
			: mainnet;

	const publicClient = createPublicClient({
		chain,
		transport,
	});

	const walletClient = createWalletClient({
		account,
		chain,
		transport,
	});

	await publicClient.request({
		method: "anvil_setBalance",
		params: [account.address, "0x100000000000000000000"],
	} as any);

	console.log(`Connected account: ${account.address}`);

	const deploymentPath = resolve(
		__dirname,
		"../../frontend/public/deployment.json",
	);
	if (!existsSync(deploymentPath)) {
		throw new Error("deployment.json not found. Run contracts:deploy first.");
	}
	const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8"));

	const axiomV2QueryAddress = getAddress(deployment.axiomV2QueryAddress);
	const creditVerifierAddress = getAddress(deployment.creditVerifierAddress);
	const scoreRegistryAddress = getAddress(deployment.scoreRegistryAddress);
	const axiomV3RelayerAddress = getAddress(deployment.axiomV3RelayerAddress);
	const creditPolicyAbi = JSON.parse(
		readFileSync(
			join(CONTRACTS_OUT, "CreditVerifier.sol/CreditVerifier.json"),
			"utf-8",
		),
	).abi;

	const transcriptLibJson = loadTranscriptLibArtifact();
	const FINALIZED_MAINNET_BLOCK = 20000000n;
	const bootstrapNonce = Math.floor(Date.now() / 1000) >>> 0;

	const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

	console.log("Generating Noir proofs in memory...");
	const proofInputs = await buildLoanProofInputs({
		userAddress: borrowerAddress,
		contractAddress: AAVE_POOL,
		nonce: bootstrapNonce,
		rpcUrl: proofRpcUrl,
		provenanceOverrides: {
			blockNumber: FINALIZED_MAINNET_BLOCK,
		},
	});

	const provisionalScoreData = await getUserFeaturesAndSignature(
		borrowerAddress,
		creditVerifierAddress,
		1,
		bootstrapNonce,
		rpcUrl,
		{
			blockNumber: FINALIZED_MAINNET_BLOCK,
		},
	);
	const provisionalScore = provisionalScoreData.predictedScore;

	const combinedProverTomlPath = resolve(
		__dirname,
		"../../circuit/combined/Prover.toml",
	);
	writeLoanProofToml(
		combinedProverTomlPath,
		toLoanProofWitnessInputs(proofInputs),
	);

	// regenerateCombinedVerifierArtifacts(); // Skip since we use deployed ones

	if (rpcUrl.includes("127.0.0.1") || rpcUrl.includes("localhost")) {
		await publicClient.request({
			method: "anvil_setBalance",
			params: [creditVerifierAddress, LOCAL_DEV_FUND_WEI],
		} as any);
		console.log(
			`Funded CreditVerifier for local testing: ${creditVerifierAddress}`,
		);
	}

	console.log(
		`Injecting verified root for block ${proofInputs.metadata.blockNumber} directly into Relayer storage...`,
	);
	const rootSlot = keccak256(
		encodeAbiParameters(parseAbiParameters("uint256, uint256"), [
			proofInputs.metadata.blockNumber,
			0n,
		]),
	);
	await publicClient.request({
		method: "anvil_setStorageAt",
		params: [axiomV3RelayerAddress, rootSlot, proofInputs.metadata.stateRoot],
	} as any);

	// Verify injection
	const verifiedRoot = await publicClient.readContract({
		address: axiomV3RelayerAddress,
		abi: JSON.parse(
			readFileSync(
				join(CONTRACTS_OUT, "AxiomV3Relayer.sol/AxiomV3Relayer.json"),
				"utf-8",
			),
		).abi,
		functionName: "verifiedRoots",
		args: [proofInputs.metadata.blockNumber],
	});
	if (verifiedRoot !== proofInputs.metadata.stateRoot) {
		throw new Error(
			`State root injection failed: expected=${proofInputs.metadata.stateRoot} actual=${verifiedRoot}`,
		);
	}
	console.log("State root successfully injected and verified on-chain.");

	console.log("Generating combined proof after verified Axiom root...");
	const combinedProofResult = await generateProof("combined", proofInputs);

	if (combinedProofResult.publicInputs.length !== 1) {
		throw new Error(
			`Unexpected combined public input count: ${combinedProofResult.publicInputs.length}`,
		);
	}

	mkdirSync(resolve(COMBINED_PROOF_FIXTURE, ".."), { recursive: true });
	writeFileSync(
		COMBINED_PROOF_FIXTURE,
		JSON.stringify(
			{
				combinedProof: {
					proof: combinedProofResult.proof,
					publicInputs: combinedProofResult.publicInputs,
				},
				scoreInputs: {
					metadata: {
						nonce: proofInputs.metadata.nonce,
						chainId: proofInputs.metadata.chainId,
						userAddress: proofInputs.metadata.userAddress,
						blockNumber: proofInputs.metadata.blockNumber.toString(),
						stateRoot: proofInputs.metadata.stateRoot,
						publicCommitment: proofInputs.metadata.publicCommitment,
						accountTrieKey: proofInputs.metadata.accountTrieKey,
						storageRoot: proofInputs.metadata.storageRoot,
						storageProofKey: proofInputs.metadata.storageProofKey,
						repaymentRate: proofInputs.metadata.repaymentRate,
						score: proofInputs.metadata.score,
						isSolvent: proofInputs.metadata.isSolvent,
					},
				},
			},
			null,
			2,
		),
		"utf-8",
	);

	const proofHash = keccak256(combinedProofResult.proof);
	const score = proofInputs.metadata.score;
	const isSolvent = proofInputs.metadata.isSolvent;
	const stateRoot = proofInputs.metadata.stateRoot;
	const publicCommitment = proofInputs.metadata.publicCommitment;
	const verifiedBlockNumber = proofInputs.metadata.blockNumber;
	if (verifiedBlockNumber === 0n) {
		throw new Error(
			"Relayer failure: verifiedBlockNumber is 0. Cannot proceed with proof generation against genesis.",
		);
	}
	const userToImpersonate = proofInputs.metadata.userAddress;

	console.log(
		`Combined public inputs: ${combinedProofResult.publicInputs.length}`,
	);
	if (combinedProofResult.publicInputs[0] !== publicCommitment) {
		throw new Error(
			`Public commitment mismatch: proof=${combinedProofResult.publicInputs[0]} input=${publicCommitment}`,
		);
	}

	await publicClient.request({
		method: "anvil_impersonateAccount",
		params: [userToImpersonate],
	} as any);

	await publicClient.request({
		method: "anvil_setBalance",
		params: [userToImpersonate, "0x100000000000000000000"],
	} as any);

	console.log(
		`Simulating verifyAndRegisterScore with score: ${score} as user ${userToImpersonate}...`,
	);
	try {
		const { request } = await publicClient.simulateContract({
			address: creditVerifierAddress,
			abi: creditPolicyAbi,
			functionName: "verifyAndRegisterScore",
			args: [
				combinedProofResult.proof,
				publicCommitment,
				score,
				isSolvent,
				proofHash,
				proofInputs.metadata.nonce,
				userToImpersonate,
				stateRoot,
				verifiedBlockNumber,
			],
			account: userToImpersonate,
		});

		console.log("Sending verifyAndRegisterScore transaction...");
		const txHash = await walletClient.writeContract({
			...request,
			account: userToImpersonate,
		} as any);
		const receipt = await publicClient.waitForTransactionReceipt({
			hash: txHash,
		});

		console.log(`Tx confirmed: ${txHash}`);

		const logs = parseEventLogs({
			abi: creditPolicyAbi,
			logs: receipt.logs,
		});

		logs.forEach((log: any) => {
			if (log.eventName === "ScoreRegistered") {
				console.log("ScoreRegistered Event:", log.args);
			}
		});
	} catch (err: any) {
		console.log("Transaction Failed!", err);
	}
}

main().catch(console.error);
