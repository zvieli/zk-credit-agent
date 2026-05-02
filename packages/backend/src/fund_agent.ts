import { createTestClient, createWalletClient, http, parseEther } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import * as dotenv from 'dotenv';

import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

async function main() {
    const privateKey = (process.env.AGENT_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const transport = http('http://127.0.0.1:8545');

    const testClient = createTestClient({
        chain: mainnet,
        mode: 'anvil',
        transport,
    });

    console.log(`Funding account: ${account.address}`);
    await testClient.setBalance({
        address: account.address,
        value: parseEther('0.5'),
    });
    console.log('Account funded!');
}

main().catch(console.error);
