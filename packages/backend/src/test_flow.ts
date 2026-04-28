import { createWalletClient, createPublicClient, http, parseEventLogs, getAddress, getContractAddress, keccak256 } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { buildSendQuery, getAxiomV2QueryAddress } from '@axiom-crypto/client';
import { DataSubqueryType, HeaderField } from '@axiom-crypto/tools';
import { buildLoanProofInputs, generateProof, regenerateCombinedVerifierArtifacts, toLoanProofWitnessInputs, writeLoanProofToml } from './prover.b.ts';
import { encodeAxiomStateRootCallbackData, getUserFeaturesAndSignature } from './index.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });
const CONTRACTS_OUT = resolve(__dirname, '../../contracts/out');
const COMBINED_PROOF_FIXTURE = resolve(__dirname, '../../contracts/test/data/combined_proof.hex');
const COMBINED_VERIFIER_ARTIFACT = join(CONTRACTS_OUT, 'combined_verifier.sol/HonkVerifier.json');
const TRANSCRIPT_LIB_ARTIFACT_CANDIDATES = [
    join(CONTRACTS_OUT, 'combined_verifier.sol/ZKTranscriptLib.json'),
    join(CONTRACTS_OUT, 'account_verifier.sol/ZKTranscriptLib.json'),
    join(CONTRACTS_OUT, 'storage_verifier.sol/ZKTranscriptLib.json'),
];
const SCORE_REGISTRY_ARTIFACT = join(CONTRACTS_OUT, 'ScoreRegistry.sol/ScoreRegistry.json');
const LOCAL_DEV_FUND_WEI = '0x3635c9adc5dea00000';

const AXIOM_QUERY_EVENT_ABI = [
    {
        type: 'event',
        name: 'QueryInitiatedOnchain',
        anonymous: false,
        inputs: [
            { name: 'caller', type: 'address', indexed: true },
            { name: 'queryHash', type: 'bytes32', indexed: true },
            { name: 'queryId', type: 'uint256', indexed: true },
            { name: 'userSalt', type: 'bytes32', indexed: false },
            { name: 'refundee', type: 'address', indexed: false },
            { name: 'target', type: 'address', indexed: false },
            { name: 'extraData', type: 'bytes', indexed: false },
        ],
    },
] as const;

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
}) {
    const sendQueryArgs = await buildSendQuery({
        chainId: String(input.chainId),
        rpcUrl: input.rpcUrl,
        axiomV2QueryAddress: input.axiomV2QueryAddress,
        dataQuery: buildHeaderStateRootQuery(input.blockNumber) as unknown as any[],
        computeQuery: {
            k: 0,
            resultLen: 1,
            vkey: [],
            computeProof: '0x00',
        },
        callback: {
            target: input.callbackTarget,
            extraData: encodeAxiomStateRootCallbackData(input.blockNumber),
        },
        caller: input.caller,
        mock: false,
        options: {},
    });

    const queryTxHash = await input.walletClient.writeContract({
        address: sendQueryArgs.address as `0x${string}`,
        abi: sendQueryArgs.abi,
        functionName: sendQueryArgs.functionName,
        args: sendQueryArgs.args,
        value: sendQueryArgs.value,
    });

    const queryReceipt = await input.publicClient.waitForTransactionReceipt({ hash: queryTxHash });
    const queryLogs = parseEventLogs({ abi: AXIOM_QUERY_EVENT_ABI, logs: queryReceipt.logs });
    const queryEvent = queryLogs.find((log) => log.eventName === 'QueryInitiatedOnchain');

    if (!queryEvent) {
        throw new Error('Missing QueryInitiatedOnchain event from Axiom dispatch');
    }

    if (getAddress(queryEvent.args.target as `0x${string}`).toLowerCase() !== input.callbackTarget.toLowerCase()) {
        throw new Error(`Unexpected Axiom callback target: ${queryEvent.args.target}`);
    }

    console.log(`Axiom query dispatched: ${queryEvent.args.queryId.toString()}`);

    await input.publicClient.request({
        method: 'anvil_impersonateAccount',
        params: [input.axiomV2QueryAddress],
    } as any);

    await input.publicClient.request({
        method: 'anvil_setBalance',
        params: [input.axiomV2QueryAddress, LOCAL_DEV_FUND_WEI],
    } as any);

    const axiomWalletClient = createWalletClient({
        account: input.axiomV2QueryAddress,
        chain: mainnet,
        transport: http(input.rpcUrl, { timeout: 300000 }),
    });

    const callbackHash = await axiomWalletClient.writeContract({
        address: input.callbackTarget,
        abi: input.creditPolicyAbi,
        functionName: 'axiomV2Callback',
        args: [BigInt(input.chainId), input.caller, `0x${'00'.repeat(32)}` as `0x${string}`, [input.stateRoot], encodeAxiomStateRootCallbackData(input.blockNumber)],
        account: input.axiomV2QueryAddress,
    });

    const callbackReceipt = await input.publicClient.waitForTransactionReceipt({ hash: callbackHash });
    const callbackLogs = parseEventLogs({ abi: input.creditPolicyAbi, logs: callbackReceipt.logs });
    const consumed = callbackLogs.find((log: any) => log.eventName === 'AxiomResultsConsumed');

    if (!consumed) {
        throw new Error('Missing AxiomResultsConsumed event after local relay');
    }

    console.log(`Axiom callback relayed for block ${input.blockNumber.toString()}`);
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
    const borrowerAddress = getAddress(process.env.ADDR || '0xE71CbF47Fff309813bcea54f3ecF49a5F129264D');
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

    const axiomV2QueryAddress = getAddress(process.env.AXIOM_V2_QUERY_ADDRESS || getAxiomV2QueryAddress('1')) as `0x${string}`;
    const transcriptLibJson = loadTranscriptLibArtifact();
    const localForkBlockNumber = await publicClient.getBlockNumber();

    const bootstrapNonce = Math.floor(Date.now() / 1000) >>> 0;
    const predictedCreditPolicyAddress = getContractAddress({
        from: account.address,
        nonce: BigInt((await publicClient.getTransactionCount({ address: account.address })) + 2),
    });

    console.log('Generating Noir proofs in memory...');
    const proofInputs = await buildLoanProofInputs({
        userAddress: borrowerAddress,
        contractAddress: predictedCreditPolicyAddress,
        nonce: bootstrapNonce,
        rpcUrl: proofRpcUrl,
        provenanceOverrides: {
            blockNumber: localForkBlockNumber + 1n,
        },
    });

    const provisionalScoreData = await getUserFeaturesAndSignature(
        borrowerAddress,
        predictedCreditPolicyAddress,
        1,
        bootstrapNonce,
        rpcUrl,
    );
    const provisionalScore = provisionalScoreData.predictedScore;

    const combinedProverTomlPath = resolve(__dirname, '../../circuit/combined/Prover.toml');
    writeLoanProofToml(combinedProverTomlPath, toLoanProofWitnessInputs(proofInputs));

    regenerateCombinedVerifierArtifacts();

    const creditPolicyJson = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'CreditPolicy.sol/CreditPolicy.json'), 'utf-8'));

    console.log('Deploying ZKTranscriptLib...');
    const transcriptLibHash = await walletClient.deployContract({
        abi: transcriptLibJson.abi,
        bytecode: transcriptLibJson.bytecode.object as `0x${string}`,
        account,
    });
    const transcriptLibReceipt = await publicClient.waitForTransactionReceipt({ hash: transcriptLibHash });
    const transcriptLibAddress = transcriptLibReceipt.contractAddress!;

    const combinedVerifierJson = loadVerifierArtifact(COMBINED_VERIFIER_ARTIFACT);
    const combinedVerifierBytecode = linkLibraryBytecode(
        combinedVerifierJson.bytecode.object,
        combinedVerifierJson.bytecode.linkReferences,
        'ZKTranscriptLib',
        transcriptLibAddress,
    );

    console.log('Deploying combined verifier...');
    const deployedCombinedVerifierHash = await walletClient.deployContract({
        abi: combinedVerifierJson.abi,
        bytecode: combinedVerifierBytecode,
        account,
    });
    const deployedCombinedVerifierReceipt = await publicClient.waitForTransactionReceipt({ hash: deployedCombinedVerifierHash });
    const deployedCombinedVerifierAddress = deployedCombinedVerifierReceipt.contractAddress!;

    console.log('Deploying CreditPolicy...');
    const creditPolicyHash = await walletClient.deployContract({
        abi: creditPolicyJson.abi,
        bytecode: creditPolicyJson.bytecode.object as `0x${string}`,
        args: [axiomV2QueryAddress, deployedCombinedVerifierAddress],
        account,
    });
    const creditPolicyReceipt = await publicClient.waitForTransactionReceipt({ hash: creditPolicyHash });
    const creditPolicyAddress = creditPolicyReceipt.contractAddress!;

    if (creditPolicyAddress.toLowerCase() !== predictedCreditPolicyAddress.toLowerCase()) {
        throw new Error(`Predicted CreditPolicy address mismatch: predicted=${predictedCreditPolicyAddress} deployed=${creditPolicyAddress}`);
    }

    if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) {
        await publicClient.request({
            method: 'anvil_setBalance',
            params: [creditPolicyAddress, LOCAL_DEV_FUND_WEI],
        } as any);
        console.log(`Funded CreditPolicy for local testing: ${creditPolicyAddress}`);
    }
    console.log(`CreditPolicy deployed at: ${creditPolicyAddress}`);

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

    const setScoreHash = await walletClient.writeContract({
        address: scoreRegistryAddress,
        abi: scoreRegistryJson.abi,
        functionName: 'setScore',
        args: [borrowerAddress, provisionalScore],
        account,
    });
    await publicClient.waitForTransactionReceipt({ hash: setScoreHash });
    console.log(`Initial score set for ${borrowerAddress}`);

    console.log('Dispatching Axiom header query and relaying callback locally...');
    await dispatchAxiomHeaderQuery({
        publicClient,
        walletClient,
        creditPolicyAbi: creditPolicyJson.abi,
        axiomV2QueryAddress,
        caller: account.address,
        callbackTarget: creditPolicyAddress,
        blockNumber: proofInputs.metadata.blockNumber,
        stateRoot: proofInputs.metadata.stateRoot,
        chainId: Number(process.env.AXIOM_SOURCE_CHAIN_ID || proofInputs.metadata.chainId || 1),
        rpcUrl,
    });

    console.log('Generating combined proof after verified Axiom root...');
    const combinedProofResult = await generateProof('combined', proofInputs);

    if (combinedProofResult.publicInputs.length !== 1) {
        throw new Error(`Unexpected combined public input count: ${combinedProofResult.publicInputs.length}`);
    }

    mkdirSync(resolve(COMBINED_PROOF_FIXTURE, '..'), { recursive: true });
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
        'utf-8',
    );

    const proofHash = keccak256(combinedProofResult.proof);
    const score = proofInputs.metadata.score;
    const isSolvent = proofInputs.metadata.isSolvent;
    const stateRoot = proofInputs.metadata.stateRoot;
    const publicCommitment = proofInputs.metadata.publicCommitment;
    const verifiedBlockNumber = proofInputs.metadata.blockNumber;
    if (verifiedBlockNumber === 0n) {
        throw new Error('Relayer failure: verifiedBlockNumber is 0. Cannot proceed with proof generation against genesis.');
    }
    const userToImpersonate = proofInputs.metadata.userAddress;

    console.log(`Combined public inputs: ${combinedProofResult.publicInputs.length}`);
    if (combinedProofResult.publicInputs[0] !== publicCommitment) {
        throw new Error(`Public commitment mismatch: proof=${combinedProofResult.publicInputs[0]} input=${publicCommitment}`);
    }

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
