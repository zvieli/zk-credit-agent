import * as dotenv from "dotenv";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { createTestClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

import { dispatchAlert, relayerBalanceEth } from "./telemetry/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });

async function main() {
	const privateKey = (process.env.AGENT_PRIVATE_KEY ||
		"0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`;
	const account = privateKeyToAccount(privateKey);
	const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
	const transport = http(rpcUrl);

	const testClient = createTestClient({
		chain: mainnet,
		mode: "anvil",
		transport,
	});

	console.log(`Funding account: ${account.address}`);
	await testClient.setBalance({
		address: account.address,
		value: parseEther("0.5"),
	});
	console.log("Account funded!");

	const balanceEth = 0.5;
	relayerBalanceEth.set({ wallet: account.address }, balanceEth);

	if (balanceEth < 0.05) {
		dispatchAlert({
			severity: "warning",
			category: "wallet_balance",
			title: "Low Relayer Wallet Gas Balance",
			message: `Wallet ${account.address} balance is low: ${balanceEth} ETH`,
			metadata: { wallet: account.address, balanceEth },
		});
	}
}

main().catch(console.error);
