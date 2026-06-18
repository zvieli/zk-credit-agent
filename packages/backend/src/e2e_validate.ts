import path from "path";
import { fileURLToPath } from "url";
import {
	type Chain,
	createPublicClient,
	createWalletClient,
	getAddress,
	type Hex,
	http,
	keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { startAxiomRelayer } from "./axiom_relayer.ts";
import {
	readVerifiedRoot,
	requestAxiomRoot,
	resolveCreditPolicyAddress,
} from "./axiom_service.ts";
import { initBackendEnv, readFrontendDeploymentConfig } from "./env.ts";
import {
	buildLoanProofInputs,
	generateProof,
	type LoanProofInputs,
	toLoanProofWitnessInputs,
	writeLoanProofToml,
} from "./prover.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

initBackendEnv();

const ANVIL_RPC = "http://127.0.0.1:8545";
const ANVIL_PK =
	"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Account #0
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const creditPolicyAbi = [
	{
		inputs: [
			{ name: "proof", type: "bytes" },
			{ name: "commitment", type: "bytes32" },
			{ name: "score", type: "uint32" },
			{ name: "isSolvent", type: "bool" },
			{ name: "proofHash", type: "bytes32" },
			{ name: "nonce", type: "uint32" },
			{ name: "user", type: "address" },
			{ name: "stateRoot", type: "bytes32" },
			{ name: "blockNumber", type: "uint256" },
		],
		name: "verifyAndRegisterScore",
		outputs: [],
		stateMutability: "external",
		type: "function",
	},
] as const;

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalAnvilChain(): Chain {
	const deployment = readFrontendDeploymentConfig();
	return {
		...mainnet,
		id: deployment.chainId ?? 31337,
	};
}

async function validateUser(userAddress: string, stableBlock: bigint) {
	console.log(`\n🚀 Starting validation for user: ${userAddress}`);

	const deployment = readFrontendDeploymentConfig();
	const creditPolicyAddress = resolveCreditPolicyAddress();
	const nonce = Math.floor(Date.now() / 1000) >>> 0;
	const localAnvil = getLocalAnvilChain();

	// 1. Request Axiom root if not verified
	let verified = await readVerifiedRoot({ blockNumber: stableBlock });
	if (!verified) {
		console.log(`[step 1] Requesting Axiom root for block ${stableBlock}...`);
		await requestAxiomRoot({
			userAddress,
			blockNumber: stableBlock,
		});

		console.log(`[step 1] Waiting for relayer to process...`);
		for (let i = 0; i < 15; i++) {
			await sleep(2000);
			verified = await readVerifiedRoot({ blockNumber: stableBlock });
			if (verified) break;
		}
	}

	if (!verified) {
		throw new Error(`Failed to verify Axiom root for block ${stableBlock}`);
	}
	console.log(`[step 1] Verified root found: ${verified.stateRoot}`);

	// 2. Build Proof Inputs
	console.log(`[step 2] Building proof inputs...`);
	const inputs = await buildLoanProofInputs({
		userAddress,
		contractAddress: AAVE_POOL,
		nonce,
		chainId: 1, // Still 1 because circuit logic verifies Mainnet MPT
		rpcUrl: ANVIL_RPC,
		provenanceOverrides: {
			blockNumber: stableBlock,
			stateRoot: verified.stateRoot,
		},
	});

	const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
	const combinedTomlPath = path.resolve(
		workspaceRoot,
		"packages/circuit/combined/Prover.toml",
	);
	writeLoanProofToml(combinedTomlPath, toLoanProofWitnessInputs(inputs));
	console.log(`[step 2] Inputs ready, Prover.toml written.`);

	// 3. Generate Proof
	console.log(`[step 3] Generating ZK proof...`);
	const proofResult = await generateProof("combined", inputs);
	console.log(`[step 3] Proof generated successfully.`);

	// 4. Submit on-chain
	console.log(`[step 4] Submitting proof to CreditPolicy...`);
	const account = privateKeyToAccount(ANVIL_PK);
	const client = createPublicClient({
		chain: localAnvil,
		transport: http(ANVIL_RPC),
	});
	const wallet = createWalletClient({
		account,
		chain: localAnvil,
		transport: http(ANVIL_RPC),
	});

	const proofHash = keccak256(proofResult.proof);
	const commitment = proofResult.publicInputs[0] as Hex;

	// Verifier expects 1 public input (the user commitment)
	const fullPublicInputs = new Array(1).fill(
		"0x0000000000000000000000000000000000000000000000000000000000000000",
	) as Hex[];
	fullPublicInputs[0] = commitment;

	try {
		const hash = await wallet.writeContract({
			address: creditPolicyAddress,
			abi: creditPolicyAbi,
			functionName: "verifyAndRegisterScore",
			args: [
				proofResult.proof,
				commitment,
				inputs.metadata.score,
				inputs.metadata.isSolvent,
				proofHash,
				inputs.metadata.nonce,
				getAddress(userAddress),
				verified.stateRoot,
				stableBlock,
			],
		});

		console.log(`[step 4] Transaction sent: ${hash}`);
		const receipt = await client.waitForTransactionReceipt({ hash });
		console.log(
			`✅ SUCCESS: User ${userAddress} validated on-chain in block ${receipt.blockNumber}`,
		);
		return true;
	} catch (err: any) {
		console.error(
			`❌ FAILED: User ${userAddress} submission failed:`,
			err.message,
		);
		return false;
	}
}

async function main() {
	const users = [
		"0xA09bFa48fDcf77544C741e7A2cFCbe0007E630DE",
		"0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
		"0x1F00db89777C0f5e6D8e74014dF9970467DA69D5",
	];

	const localAnvil = getLocalAnvilChain();
	const client = createPublicClient({
		chain: localAnvil,
		transport: http(ANVIL_RPC),
	});
	const latestBlock = await client.getBlockNumber();
	const stableBlock = latestBlock - 200n;

	console.log(
		`🎯 E2E Validation for ${users.length} users at stable block ${stableBlock}`,
	);

	const relayer = await startAxiomRelayer({
		startBlock: latestBlock,
		pollingIntervalMs: 1000,
	});

	const results = [];
	for (const user of users) {
		try {
			const ok = await validateUser(user, stableBlock);
			results.push({ user, status: ok ? "SUCCESS" : "FAILED" });
		} catch (err: any) {
			console.error(`💥 Error validating ${user}:`, err.message);
			results.push({ user, status: "ERROR", error: err.message });
		}
	}

	relayer.stop();

	console.log("\n--- Final Report ---");
	console.table(results);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
