import * as dotenv from "dotenv";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import {
	createPublicClient,
	encodeAbiParameters,
	http,
	keccak256,
	parseAbiParameters,
} from "viem";
import { mainnet } from "viem/chains";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

const FRONTEND_PUBLIC_ROOT = resolve(__dirname, "../../frontend/public");
const DEPLOYMENT_JSON_PATH = join(FRONTEND_PUBLIC_ROOT, "deployment.json");

const TARGET_BLOCK_NUMBER = 20_000_000n;

async function main() {
	console.log(`Starting Pre-flight Block Seeding for block ${TARGET_BLOCK_NUMBER}...`);

	// 1. Read Deployment Addresses
	let deployment;
	try {
		deployment = JSON.parse(readFileSync(DEPLOYMENT_JSON_PATH, "utf-8"));
	} catch (error) {
		console.error(`Failed to read deployment config from ${DEPLOYMENT_JSON_PATH}. Have the contracts been deployed?`);
		process.exit(1);
	}

	const relayerAddress = deployment.axiomV3RelayerAddress;
	if (!relayerAddress) {
		throw new Error("axiomV3RelayerAddress not found in deployment.json");
	}

	const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
	const mainnetRpcUrl =
		process.env.MAINNET_RPC_URL || "https://eth.drpc.org";

	// 2. Fetch the stateRoot from Mainnet
	console.log(`Fetching state root for block ${TARGET_BLOCK_NUMBER} from mainnet...`);
	const mainnetClient = createPublicClient({
		chain: mainnet,
		transport: http(mainnetRpcUrl),
	});

	const block = await mainnetClient.getBlock({ blockNumber: TARGET_BLOCK_NUMBER });
	const stateRoot = block.stateRoot;
	console.log(`Found state root: ${stateRoot}`);

	// 3. Inject stateRoot into Anvil
	console.log(`Injecting state root into AxiomV3Relayer at ${relayerAddress} on local Anvil node...`);
	const anvilClient = createPublicClient({
		chain: {
			...mainnet,
			id: 31337,
		},
		transport: http(rpcUrl),
	});

	// Calculate storage slot.
	// AxiomV2Client has no storage variables (axiomV2QueryAddress is immutable).
	// `mapping(uint256 => bytes32) public verifiedRoots` is the first declaration → slot 0.
	const mappingSlot = 0n;

	const slotIndex = keccak256(
		encodeAbiParameters(parseAbiParameters("uint256, uint256"), [
			TARGET_BLOCK_NUMBER,
			mappingSlot,
		])
	);

	await anvilClient.request({
		method: "anvil_setStorageAt" as any,
		params: [
			relayerAddress,
			slotIndex,
			stateRoot,
		],
	} as any);

	console.log(`✅ Successfully seeded state root ${stateRoot} for block ${TARGET_BLOCK_NUMBER} at storage slot ${slotIndex}`);
}

main().catch((error) => {
	console.error("Seeding failed:", error);
	process.exitCode = 1;
});
