import { createPublicClient, formatUnits, http, parseAbiItem } from "viem";
import { mainnet } from "viem/chains";

// הכתובת של Aave V3 Pool במייננט
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

async function main() {
	const client = createPublicClient({
		chain: mainnet,
		transport: http("http://127.0.0.1:8545", { timeout: 120000 }), // מתחבר לפורק שלך, timeout הוגדל
	});

	console.log("🕵️ Searching for recent Aave users...");

	// 1. מחפשים אירועי Supply ב-1000 הבלוקים האחרונים (במנות של 10 בלוקים)
	const latestBlock = await client.getBlockNumber();
	const allLogs: any[] = [];
	const BLOCKS_TO_SEARCH = 2000n;
	const CHUNK_SIZE = 10n;

	for (
		let currentBlock = latestBlock - BLOCKS_TO_SEARCH;
		currentBlock <= latestBlock;
		currentBlock += CHUNK_SIZE
	) {
		const toBlock =
			currentBlock + CHUNK_SIZE - 1n > latestBlock
				? latestBlock
				: currentBlock + CHUNK_SIZE - 1n;
		try {
			const logs = await client.getLogs({
				address: AAVE_POOL,
				event: parseAbiItem(
					"event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)",
				),
				fromBlock: currentBlock,
				toBlock: toBlock,
			});
			allLogs.push(...logs);
		} catch (e: any) {
			console.log(
				`Error fetching blocks ${currentBlock} to ${toBlock}: ${e.message}`,
			);
		}
	}

	// מוציאים כתובות ייחודיות ובלוק אחרון
	const userToBlock = new Map<string, bigint>();
	for (const l of allLogs) {
		const u = l.args.user;
		const b = l.blockNumber;
		if (!userToBlock.has(u) || (b && userToBlock.get(u)! < b)) {
			userToBlock.set(u, b);
		}
	}
	const users = Array.from(userToBlock.keys());
	console.log(`Found ${users.length} active users. Checking balances...`);

	for (const user of users) {
		if (!user) continue;

		// 2. בודקים את הנתונים שלהם ב-Aave
		let data: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
		try {
			data = await client.readContract({
				address: AAVE_POOL,
				abi: [
					{
						inputs: [{ type: "address", name: "user" }],
						name: "getUserAccountData",
						outputs: [
							{ type: "uint256", name: "totalCollateralBase" },
							{ type: "uint256", name: "totalDebtBase" },
							{ type: "uint256", name: "availableBorrowsBase" },
							{ type: "uint256", name: "currentLiquidationThreshold" },
							{ type: "uint256", name: "ltv" },
							{ type: "uint256", name: "healthFactor" },
						],
						stateMutability: "view",
						type: "function",
					},
				],
				functionName: "getUserAccountData",
				args: [user as `0x${string}`],
			});
		} catch (e: any) {
			console.log(`Skipping user ${user} due to Aave error/timeout`);
			continue;
		}

		// ממירים לערכים קריאים (ב-Aave Base Currency זה בד"כ 8 ספרות אחרי הנקודה)
		const collateral = Number(formatUnits(data[0], 8));
		const healthFactor = Number(formatUnits(data[5], 18));

		// Get ETH Balance
		const ethBalanceRaw = await client.getBalance({
			address: user as `0x${string}`,
		});
		const ethBalance = Number(formatUnits(ethBalanceRaw, 18));

		// Get past liquidations (Aave V3 LiquidationCall)
		// Aave V3 LiquidationCall event sig:
		// event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)
		let pastLiquidations = 0;
		try {
			const liqLogs = await client.getLogs({
				address: AAVE_POOL as `0x${string}`,
				event: parseAbiItem(
					"event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)",
				),
				args: { user: user as `0x${string}` },
				fromBlock: latestBlock - BLOCKS_TO_SEARCH,
				toBlock: latestBlock,
			});
			pastLiquidations = liqLogs.length;
		} catch (e) {
			/* ignore */
		}

		// Get Stablecoin Balance USDC
		const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
		let usdcBalance = 0;
		try {
			const usdcData = await client.readContract({
				address: USDC_ADDRESS as `0x${string}`,
				abi: [
					{
						inputs: [{ type: "address", name: "account" }],
						name: "balanceOf",
						outputs: [{ type: "uint256", name: "" }],
						stateMutability: "view",
						type: "function",
					},
				],
				functionName: "balanceOf",
				args: [user as `0x${string}`],
			});
			usdcBalance = Number(formatUnits(usdcData as bigint, 6)); // USDC has 6 decimals
		} catch (e) {
			/* ignore */
		}

		const totalDebt = Number(formatUnits(data[1], 8));
		const netEquity = collateral - totalDebt;

		// Smart Filtering logic
		const stablecoinRatio = collateral > 0 ? usdcBalance / collateral : 0;

		let category = "Standard User";
		if (ethBalance > 5 || collateral > 50000) {
			category = "The Whale";
		} else if (stablecoinRatio > 0.5 && pastLiquidations === 0) {
			category = "The Safe Borrower";
		} else if (healthFactor < 1.2 || pastLiquidations > 0) {
			category = "The At-Risk User";
		}

		// Scoring Prediction
		const diversity = Math.min(Math.floor(healthFactor), 100);
		const hfBonus = diversity > 3 ? 150 : diversity * 50;

		const stable_ratio = Math.min(100, Math.floor(stablecoinRatio * 100));
		const stableBonus = stable_ratio > 50 ? 100 : 0;

		// repayment_consistency_score matching index.ts math (Math.min(Number(ethBalance / 10n**17n) * 10, 500))
		const historical_bonus = Math.min(Math.floor(ethBalance * 100), 500);

		const walletWealth = historical_bonus + stableBonus;

		let penalty = pastLiquidations * 300;
		if (totalDebt === 0) penalty += 200;

		const predictedScore = netEquity / 20 + hfBonus + walletWealth - penalty;
		const finalPredictedScore = Math.max(
			0,
			Math.min(Math.floor(predictedScore), 1000),
		);

		if (usdcBalance >= 0) {
			console.log(`-------------------`);
			console.log(`✅ ${category}: ${user}`);
			console.log(
				`💰 Collateral: $${collateral.toFixed(2)} | ETH: ${ethBalance.toFixed(2)} | USDC: $${usdcBalance.toFixed(2)}`,
			);
			console.log(
				`🏥 Health Factor: ${healthFactor > 100 ? "Safe" : healthFactor.toFixed(2)} | Liquidations: ${pastLiquidations}`,
			);
			console.log(`📦 Last Activity Block: ${userToBlock.get(user)}`);
			console.log(`🔮 Predicted ZK Score: ${predictedScore.toFixed(2)}`);
			console.log(`🔮 Normalized ZK Score: ${finalPredictedScore}/1000`);

			if (finalPredictedScore >= 300) {
				const rate =
					finalPredictedScore >= 850
						? "2%"
						: finalPredictedScore >= 600
							? "5%"
							: "8%";
				console.log(`✅ Status: APPROVED (Est. Rate: ${rate})`);
			} else {
				console.log(`❌ Status: REJECTED (Score too low)`);
			}
		}
	}
}

main().catch(console.error);
