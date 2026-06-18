import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import {
	createPublicClient,
	encodeAbiParameters,
	formatUnits,
	getAddress,
	http,
	keccak256,
	parseAbiItem,
	parseAbiParameters,
	toHex,
} from "viem";
import { mainnet } from "viem/chains";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

type Address = `0x${string}`;

interface RealProfile {
	address: Address;
	activityBlock: bigint;
	ethBalance: bigint;
	usdcBalance: bigint;
	realNonce: number;
	collateralBase: bigint;
	debtBase: bigint;
	healthFactor: bigint;
	userConfig: bigint;
}

interface SeedRecord {
	anvilIndex: number;
	anvilAddress: Address;
	profile: RealProfile;
	accountProofOk: boolean;
	usdcProofOk: boolean;
	poolConfigProofOk: boolean;
}

function resolveLocalRpcUrl() {
	return process.env.ANVIL_RPC_URL || "http://127.0.0.1:8545";
}

function resolveSourceRpcUrl() {
	if (process.env.PROFILE_RPC_URL) {
		return process.env.PROFILE_RPC_URL;
	}

	if (process.env.PROOF_RPC_URL) {
		return process.env.PROOF_RPC_URL;
	}

	if (
		process.env.RPC_URL &&
		!process.env.RPC_URL.includes("127.0.0.1") &&
		!process.env.RPC_URL.includes("localhost")
	) {
		return process.env.RPC_URL;
	}

	return "http://127.0.0.1:8545";
}

const AAVE_POOL_ADDRESS = getAddress(
	process.env.AAVE_V3_POOL_ADDRESS ||
		"0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
);
const USDC_ADDRESS = getAddress(
	process.env.USDC_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
);
const REAL_PROFILE_LIMIT = Number(process.env.SEED_PROFILE_LIMIT || "9");
const LOOKBACK_WINDOWS = (process.env.SEED_LOOKBACK_BLOCKS || "1000,5000,10000")
	.split(",")
	.map((value) => Number(value.trim()))
	.filter((value) => Number.isFinite(value) && value > 0)
	.sort((left, right) => left - right);
const FALLBACK_LOOKBACK_WINDOWS = [
	25000, 50000, 100000, 250000, 500000, 1000000,
];
const CHUNK_SIZE = BigInt(process.env.SEED_CHUNK_SIZE || "10");
const INJECTED_NONCE = 500n;
const USDC_BALANCE_SLOT = 9n;
const AAVE_POOL_USERS_CONFIG_SLOT = BigInt(
	process.env.AAVE_POOL_USERS_CONFIG_SLOT || "53",
);
const ENABLE_AAVE_POOL_CONFIG =
	(process.env.SEED_AAVE_USER_CONFIG || "true").toLowerCase() !== "false";

const supplyEvent = parseAbiItem(
	"event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
);
const borrowEvent = parseAbiItem(
	"event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)",
);
const repayEvent = parseAbiItem(
	"event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)",
);
const withdrawEvent = parseAbiItem(
	"event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)",
);
const liquidationEvent = parseAbiItem(
	"event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
);

const activityEvents = [
	{ event: supplyEvent, userField: "onBehalfOf" },
	{ event: borrowEvent, userField: "onBehalfOf" },
	{ event: repayEvent, userField: "user" },
	{ event: withdrawEvent, userField: "user" },
	{ event: liquidationEvent, userField: "user" },
] as const;

const poolAbi = [
	{
		inputs: [{ internalType: "address", name: "user", type: "address" }],
		name: "getUserAccountData",
		outputs: [
			{ internalType: "uint256", name: "totalCollateralBase", type: "uint256" },
			{ internalType: "uint256", name: "totalDebtBase", type: "uint256" },
			{
				internalType: "uint256",
				name: "availableBorrowsBase",
				type: "uint256",
			},
			{
				internalType: "uint256",
				name: "currentLiquidationThreshold",
				type: "uint256",
			},
			{ internalType: "uint256", name: "ltv", type: "uint256" },
			{ internalType: "uint256", name: "healthFactor", type: "uint256" },
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [{ internalType: "address", name: "user", type: "address" }],
		name: "getUserConfiguration",
		outputs: [
			{
				internalType: "struct DataTypes.UserConfigurationMap",
				name: "",
				type: "tuple",
				components: [
					{ internalType: "uint256", name: "data", type: "uint256" },
				],
			},
		],
		stateMutability: "view",
		type: "function",
	},
] as const;

const erc20Abi = [
	{
		inputs: [{ internalType: "address", name: "account", type: "address" }],
		name: "balanceOf",
		outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

function createClient(rpcUrl: string) {
	return createPublicClient({
		chain: mainnet,
		transport: http(rpcUrl, { timeout: 180000 }),
	});
}

function quantity(value: bigint) {
	return toHex(value);
}

function word(value: bigint) {
	return toHex(value, { size: 32 });
}

function shortEth(value: bigint) {
	return Number.parseFloat(formatUnits(value, 18)).toFixed(4);
}

function shortUsdc(value: bigint) {
	return Number.parseFloat(formatUnits(value, 6)).toFixed(2);
}

function classifyProfile(profile: RealProfile) {
	if (profile.collateralBase > 0n && profile.debtBase > 0n) {
		return "Borrower";
	}

	if (
		profile.usdcBalance > 1_000_000_000n ||
		profile.ethBalance > 5n * 10n ** 18n
	) {
		return "Whale";
	}

	if (profile.usdcBalance > 0n || profile.userConfig !== 0n) {
		return "Active Saver";
	}

	return "Dormant";
}

async function discoverRealProfiles(
	client = createClient(resolveSourceRpcUrl()),
) {
	const latestBlock = await client.getBlockNumber();
	const userToBlock = new Map<Address, bigint>();
	const windows = [...LOOKBACK_WINDOWS];

	for (const fallbackWindow of FALLBACK_LOOKBACK_WINDOWS) {
		if (!windows.includes(fallbackWindow)) {
			windows.push(fallbackWindow);
		}
	}

	windows.sort((left, right) => left - right);

	for (const windowBlocks of windows) {
		const fromBlock =
			latestBlock > BigInt(windowBlocks)
				? latestBlock - BigInt(windowBlocks)
				: 0n;
		console.log(`Searching last ${windowBlocks} blocks for Aave activity...`);

		for (
			let current = fromBlock;
			current <= latestBlock;
			current += CHUNK_SIZE
		) {
			const toBlock =
				current + CHUNK_SIZE - 1n > latestBlock
					? latestBlock
					: current + CHUNK_SIZE - 1n;

			for (const { event, userField } of activityEvents) {
				try {
					const logs = await client.getLogs({
						address: AAVE_POOL_ADDRESS,
						event,
						fromBlock: current,
						toBlock,
					});

					for (const log of logs) {
						const logArgs = log.args as Record<string, Address | undefined>;
						const candidate =
							userField === "user" ? logArgs.user : logArgs.onBehalfOf;
						if (!candidate) {
							continue;
						}

						const address = getAddress(candidate);
						const blockNumber = log.blockNumber ?? 0n;
						if (
							!userToBlock.has(address) ||
							userToBlock.get(address)! < blockNumber
						) {
							userToBlock.set(address, blockNumber);
						}
					}
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.log(
						`Skipping ${event.name} range ${current}..${toBlock}: ${message}`,
					);
				}
			}

			if (userToBlock.size >= REAL_PROFILE_LIMIT) {
				break;
			}
		}

		if (userToBlock.size >= REAL_PROFILE_LIMIT) {
			break;
		}
	}

	if (userToBlock.size < REAL_PROFILE_LIMIT) {
		console.log(
			`Found only ${userToBlock.size} candidates after adaptive search; continuing with the available set.`,
		);
	}

	const candidates = [...userToBlock.entries()].sort((left, right) =>
		Number((right[1] ?? 0n) - (left[1] ?? 0n)),
	);
	const profiles: RealProfile[] = [];

	for (const [user, activityBlock] of candidates) {
		if (profiles.length >= REAL_PROFILE_LIMIT) {
			break;
		}

		try {
			const [
				accountData,
				ethBalance,
				usdcBalance,
				realNonce,
				userConfigResult,
			] = await Promise.all([
				client.readContract({
					address: AAVE_POOL_ADDRESS,
					abi: poolAbi,
					functionName: "getUserAccountData",
					args: [user],
				}) as Promise<
					readonly [bigint, bigint, bigint, bigint, bigint, bigint]
				>,
				client.getBalance({ address: user }),
				client.readContract({
					address: USDC_ADDRESS,
					abi: erc20Abi,
					functionName: "balanceOf",
					args: [user],
				}) as Promise<bigint>,
				client.getTransactionCount({ address: user }),
				client.readContract({
					address: AAVE_POOL_ADDRESS,
					abi: poolAbi,
					functionName: "getUserConfiguration",
					args: [user],
				}) as Promise<{ data?: bigint } | bigint>,
			]);

			const userConfig =
				typeof userConfigResult === "bigint"
					? userConfigResult
					: (userConfigResult.data ?? 0n);

			if (
				usdcBalance === 0n &&
				accountData[0] === 0n &&
				accountData[1] === 0n
			) {
				continue;
			}

			profiles.push({
				address: user,
				activityBlock,
				ethBalance,
				usdcBalance,
				realNonce,
				collateralBase: accountData[0],
				debtBase: accountData[1],
				healthFactor: accountData[5],
				userConfig,
			});
		} catch {
			console.log(`Skipping profile ${user} due to RPC error`);
		}
	}

	return profiles.slice(0, Math.min(REAL_PROFILE_LIMIT, profiles.length));
}

async function setStorageWord(
	client: ReturnType<typeof createClient>,
	contractAddress: Address,
	slotKey: Address,
	value: bigint,
) {
	await client.request({
		method: "anvil_setStorageAt",
		params: [contractAddress, slotKey, word(value)],
	} as any);
}

async function seedProfile(
	client: ReturnType<typeof createClient>,
	localAddress: Address,
	profile: RealProfile,
	seedPoolConfig = ENABLE_AAVE_POOL_CONFIG,
) {
	await client.request({
		method: "anvil_setBalance",
		params: [localAddress, quantity(profile.ethBalance)],
	} as any);

	await client.request({
		method: "anvil_setNonce",
		params: [localAddress, quantity(INJECTED_NONCE)],
	} as any);

	const usdcSlot = keccak256(
		encodeAbiParameters(parseAbiParameters("address, uint256"), [
			localAddress,
			USDC_BALANCE_SLOT,
		]),
	);
	await setStorageWord(
		client,
		USDC_ADDRESS,
		usdcSlot as Address,
		profile.usdcBalance,
	);

	if (seedPoolConfig) {
		const poolConfigSlot = keccak256(
			encodeAbiParameters(parseAbiParameters("address, uint256"), [
				localAddress,
				AAVE_POOL_USERS_CONFIG_SLOT,
			]),
		);
		await setStorageWord(
			client,
			AAVE_POOL_ADDRESS,
			poolConfigSlot as Address,
			profile.userConfig,
		);
	}

	return { usdcSlot, seedPoolConfig };
}

async function verifyProofPaths(
	client: ReturnType<typeof createClient>,
	localAddress: Address,
	usdcSlot: Address,
	seedPoolConfig: boolean,
) {
	const blockNumber = await client.getBlockNumber();

	await client.getProof({
		address: localAddress,
		storageKeys: [],
		blockNumber,
	});

	await client.getProof({
		address: USDC_ADDRESS,
		storageKeys: [usdcSlot],
		blockNumber,
	});

	if (seedPoolConfig) {
		const poolConfigSlot = keccak256(
			encodeAbiParameters(parseAbiParameters("address, uint256"), [
				localAddress,
				AAVE_POOL_USERS_CONFIG_SLOT,
			]),
		);
		await client.getProof({
			address: AAVE_POOL_ADDRESS,
			storageKeys: [poolConfigSlot as Address],
			blockNumber,
		});
	}
}

function printSummary(records: SeedRecord[]) {
	console.log("\nSeed summary");
	console.table(
		records.map((record) => ({
			anvil: `#${record.anvilIndex}`,
			anvilAddress: record.anvilAddress,
			realAddress: record.profile.address,
			label: classifyProfile(record.profile),
			eth: shortEth(record.profile.ethBalance),
			usdc: shortUsdc(record.profile.usdcBalance),
			realNonce: record.profile.realNonce,
			injectedNonce: Number(INJECTED_NONCE),
			collateralBase: record.profile.collateralBase.toString(),
			debtBase: record.profile.debtBase.toString(),
			healthFactor: formatUnits(record.profile.healthFactor, 18),
			userConfig: `0x${record.profile.userConfig.toString(16)}`,
			proofs:
				record.accountProofOk &&
				record.usdcProofOk &&
				(!ENABLE_AAVE_POOL_CONFIG || record.poolConfigProofOk)
					? "ok"
					: "partial",
		})),
	);
}

async function main() {
	const localRpcUrl = resolveLocalRpcUrl();
	const sourceRpcUrl = resolveSourceRpcUrl();
	console.log(`Discovery RPC: ${sourceRpcUrl}`);
	console.log(`Injection RPC: ${localRpcUrl}`);

	const localClient = createClient(localRpcUrl);
	const profiles = await discoverRealProfiles(createClient(sourceRpcUrl));
	const localAccounts = (await localClient.request({
		method: "eth_accounts",
	} as any)) as string[];
	const seededAccounts = localAccounts
		.slice(1, 1 + profiles.length)
		.map((value) => getAddress(value));

	if (seededAccounts.length < profiles.length) {
		throw new Error(
			`Anvil returned only ${seededAccounts.length} unlocked accounts; need ${profiles.length} to seed accounts 1-${profiles.length}.`,
		);
	}

	const records: SeedRecord[] = [];

	for (let index = 0; index < profiles.length; index += 1) {
		const profile = profiles[index]!;
		const anvilAddress = seededAccounts[index]!;
		const { usdcSlot, seedPoolConfig } = await seedProfile(
			localClient,
			anvilAddress,
			profile,
		);
		await verifyProofPaths(
			localClient,
			anvilAddress,
			usdcSlot as Address,
			seedPoolConfig,
		);

		records.push({
			anvilIndex: index + 1,
			anvilAddress,
			profile,
			accountProofOk: true,
			usdcProofOk: true,
			poolConfigProofOk: seedPoolConfig,
		});
		console.log(
			`Seeded Anvil account #${index + 1} with real user ${profile.address}`,
		);
	}

	printSummary(records);
	console.log(
		"\nDone. Local Anvil accounts 1-9 now mirror the discovered real profiles.",
	);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
