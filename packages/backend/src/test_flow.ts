import { createWalletClient, createPublicClient, http, parseEventLogs, getAddress, keccak256, concatHex } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync } from 'fs';
import { resolve, join } from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { buildLoanProofInputs, generateProof } from './generate_prover.ts';
import { encodeAxiomStateRootCallbackData, getUserFeaturesAndSignature } from './index.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });
const CONTRACTS_OUT = resolve(__dirname, '../../contracts/out');
const ACCOUNT_VERIFIER_ARTIFACT = join(CONTRACTS_OUT, 'account_verifier.sol/HonkVerifier.json');
const STORAGE_VERIFIER_ARTIFACT = join(CONTRACTS_OUT, 'storage_verifier.sol/HonkVerifier.json');
const TRANSCRIPT_LIB_ARTIFACT_CANDIDATES = [
    join(CONTRACTS_OUT, 'account_verifier.sol/ZKTranscriptLib.json'),
    join(CONTRACTS_OUT, 'storage_verifier.sol/ZKTranscriptLib.json'),
];
const SCORE_REGISTRY_ARTIFACT = join(CONTRACTS_OUT, 'ScoreRegistry.sol/ScoreRegistry.json');
const LOCAL_DEV_FUND_WEI = '0x3635c9adc5dea00000';

function loadVerifierArtifact(filePath: string) {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function loadTranscriptLibArtifact() {
    for (const artifactPath of TRANSCRIPT_LIB_ARTIFACT_CANDIDATES) {
        try {
            return JSON.parse(readFileSync(artifactPath, 'utf-8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
    }

    throw new Error(`Missing ZKTranscriptLib artifact. Looked in: ${TRANSCRIPT_LIB_ARTIFACT_CANDIDATES.join(', ')}`);
}

function linkLibraryBytecode(
    bytecode: string,
    linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>,
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

    if (linkedBytecode.includes('__$')) {
        throw new Error(`Unresolved library placeholders remain in ${libraryName} bytecode.`);
    }

    return linkedBytecode as `0x${string}`;
}

function ensureVerifierArtifacts() {
    if (existsSync(ACCOUNT_VERIFIER_ARTIFACT) && existsSync(STORAGE_VERIFIER_ARTIFACT)) {
        return;
    }

    console.log('Generating Solidity verifier sources...');
    execSync('bb write_solidity_verifier -t evm -k ./target/proof/vk -o ../../contracts/src/account_verifier.sol', {
        cwd: resolve(__dirname, '../../circuit/account'),
        stdio: 'inherit',
    });
    execSync('bb write_solidity_verifier -t evm -k ./target/proof/vk -o ../../contracts/src/storage_verifier.sol', {
        cwd: resolve(__dirname, '../../circuit/storage'),
        stdio: 'inherit',
    });

    console.log('Building contract artifacts...');
    execSync('forge build -q', {
        cwd: resolve(__dirname, '../../contracts'),
        stdio: 'inherit',
    });
}

async function main() {
    const privateKey = (process.env.AGENT_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const proofRpcUrl =
        process.env.PROOF_RPC_URL ||
        process.env.MAINNET_RPC_URL ||
        (process.env.ALCHEMY_API_KEY ? `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}` : rpcUrl);
    const transport = http(rpcUrl, {
        timeout: 300000,
    });
    const borrowerAddress = getAddress(process.env.ADDR || '0x9008D19f58AAbD9eD0D60971565AA8510560ab41');
    process.env.PROOF_RPC_URL = proofRpcUrl;
    console.log(`Using proof RPC: ${proofRpcUrl}`);

    const publicClient = createPublicClient({
        chain: mainnet,
        transport,
    });

    const walletClient = createWalletClient({
        account,
        chain: mainnet,
        transport,
    });

    await publicClient.request({
        method: 'anvil_setBalance',
        params: [account.address, '0x100000000000000000000'],
    } as any);

    console.log(`Connected account: ${account.address}`);

    const creditPolicyJson = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'CreditPolicy.sol/CreditPolicy.json'), 'utf-8'));
    const axiomV2QueryAddress = (process.env.AXIOM_V2_QUERY_ADDRESS || account.address) as `0x${string}`;
    const transcriptLibJson = loadTranscriptLibArtifact();

    if (!process.env.ACCOUNT_VERIFIER_ADDRESS || !process.env.STORAGE_VERIFIER_ADDRESS) {
        if (!process.env.ACCOUNT_VERIFIER_ADDRESS && !process.env.STORAGE_VERIFIER_ADDRESS) {
            ensureVerifierArtifacts();
            console.log('Deploying ZKTranscriptLib...');
            const transcriptLibHash = await walletClient.deployContract({
                abi: transcriptLibJson.abi,
                bytecode: transcriptLibJson.bytecode.object as `0x${string}`,
                account,
            });
            const transcriptLibReceipt = await publicClient.waitForTransactionReceipt({ hash: transcriptLibHash });
            const transcriptLibAddress = transcriptLibReceipt.contractAddress!;

            const accountVerifierJson = loadVerifierArtifact(ACCOUNT_VERIFIER_ARTIFACT);
            const storageVerifierJson = loadVerifierArtifact(STORAGE_VERIFIER_ARTIFACT);
            const accountVerifierBytecode = linkLibraryBytecode(
                accountVerifierJson.bytecode.object,
                accountVerifierJson.bytecode.linkReferences,
                'ZKTranscriptLib',
                transcriptLibAddress,
            );
            const storageVerifierBytecode = linkLibraryBytecode(
                storageVerifierJson.bytecode.object,
                storageVerifierJson.bytecode.linkReferences,
                'ZKTranscriptLib',
                transcriptLibAddress,
            );

            console.log('Deploying account verifier...');
            const deployedAccountVerifierHash = await walletClient.deployContract({
                abi: accountVerifierJson.abi,
                bytecode: accountVerifierBytecode,
                account,
            });
            const deployedAccountVerifierReceipt = await publicClient.waitForTransactionReceipt({ hash: deployedAccountVerifierHash });
            const deployedAccountVerifierAddress = deployedAccountVerifierReceipt.contractAddress!;

            console.log('Deploying storage verifier...');
            const deployedStorageVerifierHash = await walletClient.deployContract({
                abi: storageVerifierJson.abi,
                bytecode: storageVerifierBytecode,
                account,
            });
            const deployedStorageVerifierReceipt = await publicClient.waitForTransactionReceipt({ hash: deployedStorageVerifierHash });
            const deployedStorageVerifierAddress = deployedStorageVerifierReceipt.contractAddress!;

            process.env.ACCOUNT_VERIFIER_ADDRESS = deployedAccountVerifierAddress;
            process.env.STORAGE_VERIFIER_ADDRESS = deployedStorageVerifierAddress;
        } else {
            throw new Error('Both ACCOUNT_VERIFIER_ADDRESS and STORAGE_VERIFIER_ADDRESS must be set, or neither to auto-deploy from artifacts.');
        }
    }

    const verifierAccountAddress = getAddress(process.env.ACCOUNT_VERIFIER_ADDRESS!);
    const verifierStorageAddress = getAddress(process.env.STORAGE_VERIFIER_ADDRESS!);

    console.log('Deploying CreditPolicy...');
    const creditPolicyHash = await walletClient.deployContract({
        abi: creditPolicyJson.abi,
        bytecode: creditPolicyJson.bytecode.object as `0x${string}`,
        args: [axiomV2QueryAddress, verifierAccountAddress, verifierStorageAddress],
        account,
    });
    const creditPolicyReceipt = await publicClient.waitForTransactionReceipt({ hash: creditPolicyHash });
    const creditPolicyAddress = creditPolicyReceipt.contractAddress!;

    if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) {
        await publicClient.request({
            method: 'anvil_setBalance',
            params: [creditPolicyAddress, LOCAL_DEV_FUND_WEI],
        } as any);
        console.log(`Funded CreditPolicy for local testing: ${creditPolicyAddress}`);
    }
    console.log(`CreditPolicy deployed at: ${creditPolicyAddress}`);

    if (!existsSync(SCORE_REGISTRY_ARTIFACT)) {
        console.log('Building contract artifacts...');
        execSync('forge build -q', {
            cwd: resolve(__dirname, '../../contracts'),
            stdio: 'inherit',
        });
    }

    const scoreRegistryJson = JSON.parse(readFileSync(SCORE_REGISTRY_ARTIFACT, 'utf-8'));
    console.log('Deploying ScoreRegistry...');
    const scoreRegistryHash = await walletClient.deployContract({
        abi: scoreRegistryJson.abi,
        bytecode: scoreRegistryJson.bytecode.object as `0x${string}`,
        account,
    });
    const scoreRegistryReceipt = await publicClient.waitForTransactionReceipt({ hash: scoreRegistryHash });
    const scoreRegistryAddress = scoreRegistryReceipt.contractAddress!;
    console.log(`ScoreRegistry deployed at: ${scoreRegistryAddress}`);

    const bootstrapNonce = Math.floor(Date.now() / 1000) >>> 0;
const provisionalScoreData = await getUserFeaturesAndSignature(
    borrowerAddress,
    creditPolicyAddress,
    1,
    bootstrapNonce,
    rpcUrl
);
const provisionalScore = provisionalScoreData.predictedScore;
const provisionalRepaymentRate = provisionalScore * 10_000;

const setScoreHash = await walletClient.writeContract({
    address: scoreRegistryAddress,
    abi: scoreRegistryJson.abi,
    functionName: 'setScore',
    args: [borrowerAddress, provisionalScore],
    account,
});await publicClient.waitForTransactionReceipt({ hash: setScoreHash });
console.log(`Initial score set for ${borrowerAddress}`);

console.log('Generating Noir proofs in memory...');
    const proofInputs = await buildLoanProofInputs({
        userAddress: borrowerAddress,
        contractAddress: creditPolicyAddress,
        nonce: bootstrapNonce,
        rpcUrl: proofRpcUrl,
    });

    console.log('Calling the real Axiom callback entrypoint...');
    const axiomCallbackHash = await walletClient.writeContract({
        address: creditPolicyAddress,
        abi: creditPolicyJson.abi,
        functionName: 'axiomV2Callback',
        args: [
            BigInt(process.env.AXIOM_SOURCE_CHAIN_ID || 1),
            account.address,
            (process.env.AXIOM_QUERY_SCHEMA || `0x${'00'.repeat(32)}`) as `0x${string}`,
            [proofInputs.metadata.stateRoot],
            encodeAxiomStateRootCallbackData(proofInputs.metadata.blockNumber),
        ],
        account,
    });
    await publicClient.waitForTransactionReceipt({ hash: axiomCallbackHash });

    console.log('Generating account proof...');
    const accountProofResult = await generateProof('account', proofInputs.account);
    console.log('Generating storage proof...');
    const storageProofResult = await generateProof('storage', proofInputs.storage);

    if (accountProofResult.publicInputs.length !== 64) {
        throw new Error(`Unexpected account public input count: ${accountProofResult.publicInputs.length}`);
    }

    if (storageProofResult.publicInputs.length !== 98) {
        throw new Error(`Unexpected storage public input count: ${storageProofResult.publicInputs.length}`);
    }

    const proofHash = keccak256(concatHex([accountProofResult.proof, storageProofResult.proof]));
    const score = proofInputs.metadata.score;
    const isSolvent = proofInputs.metadata.isSolvent;
    const stateRoot = proofInputs.metadata.stateRoot;
    const storageRoot = proofInputs.metadata.storageRoot;
    const storageProofKey = proofInputs.metadata.storageProofKey;
    const verifiedBlockNumber = proofInputs.metadata.blockNumber;
    if (verifiedBlockNumber === 0n) {
        throw new Error("Relayer failure: verifiedBlockNumber is 0. Cannot proceed with proof generation against genesis.");
    }
    const userToImpersonate = proofInputs.metadata.userAddress;

    console.log(`Account public inputs: ${accountProofResult.publicInputs.length}`);
    console.log(`Storage public inputs: ${storageProofResult.publicInputs.length}`);

    await publicClient.request({
        method: 'anvil_impersonateAccount',
        params: [userToImpersonate],
    } as any);

    await publicClient.request({
        method: 'anvil_setBalance',
        params: [userToImpersonate, '0x100000000000000000000'],
    } as any);

    console.log(`Simulating verifyAndRegisterScore with score: ${score} as user ${userToImpersonate}...`);
    try {
        const { request } = await publicClient.simulateContract({
            address: creditPolicyAddress,
            abi: creditPolicyJson.abi,
            functionName: 'verifyAndRegisterScore',
            args: [
                accountProofResult.proof,
                storageProofResult.proof,
                score,
                isSolvent,
                proofHash,
                proofInputs.metadata.nonce,
                userToImpersonate,
                stateRoot,
                storageRoot,
                storageProofKey,
                verifiedBlockNumber,
            ],
            account: userToImpersonate,
        });

        console.log('Sending verifyAndRegisterScore transaction...');
        const txHash = await walletClient.writeContract({
            ...request,
            account: userToImpersonate,
        } as any);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        console.log(`Tx confirmed: ${txHash}`);

        const logs = parseEventLogs({
            abi: creditPolicyJson.abi,
            logs: receipt.logs,
        });

        logs.forEach((log: any) => {
            if (log.eventName === 'ScoreRegistered') {
                console.log('ScoreRegistered Event:', log.args);
            }
        });
    } catch (err: any) {
        console.log('Transaction Failed!', err);
    }
}

main().catch(console.error);
