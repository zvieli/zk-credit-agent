import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { buildLoanProofInputs, generateProof } from './prover.b.ts';
import { getUserFeaturesAndSignature } from './index.ts';

function isMainModule() {
	const entryFile = process.argv[1];
	if (!entryFile) {
		return false;
	}

	return fileURLToPath(import.meta.url) === path.resolve(entryFile);
}

function toTomlValue(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => toTomlValue(item)).join(', ')}]`;
	}

	if (typeof value === 'string') {
		return value.startsWith('0x') ? `"${value}"` : value;
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (typeof value === 'number') {
		return Number.isFinite(value) ? value.toString() : '0';
	}

	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}

	if (value === null || value === undefined) {
		return '[]';
	}

	if (typeof value === 'object') {
		return JSON.stringify(value);
	}

	return String(value);
}

function toTomlDocument(inputs: Record<string, unknown>) {
	return Object.entries(inputs)
		.map(([key, value]) => `${key} = ${toTomlValue(value)}`)
		.join('\n');
}

async function main() {
	const borrowerAddress = process.argv[2] ?? process.env.ADDR;
	if (!borrowerAddress) {
		throw new Error('Missing borrower address. Pass ADDR or a positional address argument.');
	}

	const privateKey = (process.env.AGENT_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
	const account = privateKeyToAccount(privateKey);
	const rpcUrl = process.env.RPC_URL || process.env.PROOF_RPC_URL || 'http://127.0.0.1:8545';
	const chainId = process.env.CIRCUIT_CHAIN_ID ? Number(process.env.CIRCUIT_CHAIN_ID) : 1;
	const nonce = process.env.CIRCUIT_NONCE ? Number(process.env.CIRCUIT_NONCE) : Math.floor(Date.now() / 1000) >>> 0;
	const publicClient = createPublicClient({
		chain: mainnet,
		transport: http(rpcUrl, { timeout: 300000 }),
	});
	process.env.PROOF_RPC_URL = rpcUrl;
	const walletClient = createWalletClient({
		account,
		chain: mainnet,
		transport: http(rpcUrl, { timeout: 300000 }),
	});

	await publicClient.request({
		method: 'anvil_setBalance',
		params: [account.address, '0x100000000000000000000'],
	} as any);

	const contractsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');
	const scoreRegistryArtifactPath = path.resolve(contractsRoot, 'out/ScoreRegistry.sol/ScoreRegistry.json');
	const scoreRegistryArtifact = JSON.parse(readFileSync(scoreRegistryArtifactPath, 'utf-8'));

	const deployedScoreRegistryHash = await walletClient.deployContract({
		abi: scoreRegistryArtifact.abi,
		bytecode: scoreRegistryArtifact.bytecode.object as `0x${string}`,
	});
	const deployedScoreRegistryReceipt = await publicClient.waitForTransactionReceipt({ hash: deployedScoreRegistryHash });
	const scoreRegistryAddress = deployedScoreRegistryReceipt.contractAddress!;

	const provisionalScoreData = await getUserFeaturesAndSignature(borrowerAddress, scoreRegistryAddress, chainId, nonce);
	const provisionalScore = provisionalScoreData.predictedScore;
	const provisionalRepaymentRate = provisionalScore * 10_000;

	const setScoreHash = await walletClient.writeContract({
		address: scoreRegistryAddress,
		abi: scoreRegistryArtifact.abi,
		functionName: 'setScore',
		args: [borrowerAddress, provisionalRepaymentRate],
	});
	await publicClient.waitForTransactionReceipt({ hash: setScoreHash });

	const proofInputs = await buildLoanProofInputs({
		userAddress: borrowerAddress,
		contractAddress: scoreRegistryAddress,
		nonce,
		chainId,
		scoreRegistryAddress,
	});

	const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
	const accountTomlPath = path.resolve(workspaceRoot, 'packages/circuit/account/Prover.toml');
	const storageTomlPath = path.resolve(workspaceRoot, 'packages/circuit/storage/Prover.toml');

	mkdirSync(path.dirname(accountTomlPath), { recursive: true });
	mkdirSync(path.dirname(storageTomlPath), { recursive: true });

	writeFileSync(accountTomlPath, toTomlDocument(proofInputs.account));
	writeFileSync(storageTomlPath, toTomlDocument(proofInputs.storage));

	console.log(`Wrote ${accountTomlPath}`);
	console.log(`Wrote ${storageTomlPath}`);
}

if (isMainModule()) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}

export { buildLoanProofInputs, generateProof } from './prover.b.ts';
