import { createWalletClient, createPublicClient, http, getAddress, type Hex } from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const CONTRACTS_OUT = resolve(__dirname, '../../contracts/out');
const FRONTEND_PUBLIC_ROOT = resolve(__dirname, '../../frontend/public');
const DEPLOYMENT_JSON_PATH = join(FRONTEND_PUBLIC_ROOT, 'deployment.json');
const LOCAL_DEV_FUND_WEI = '0x3635c9adc5dea00000';
const TRANSCRIPT_LIB_ARTIFACT_CANDIDATES = [
  join(CONTRACTS_OUT, 'account_verifier.sol/ZKTranscriptLib.json'),
  join(CONTRACTS_OUT, 'storage_verifier.sol/ZKTranscriptLib.json'),
];

function linkLibrary(bytecode: string, libAddress: string): string {
  return bytecode.replace(/__\$[0-9a-fA-F]+\$__/g, libAddress.slice(2).toLowerCase());
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

async function main() {
  const privateKey = process.env.AGENT_PRIVATE_KEY as Hex;
  if (!privateKey) throw new Error('Missing AGENT_PRIVATE_KEY');

  const account = privateKeyToAccount(privateKey);
  const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
  const chain = rpcUrl.includes('sepolia') ? sepolia : mainnet;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log(`Starting deployment from: ${account.address}`);

  console.log('Deploying ZKTranscriptLib...');
  const libArtifact = loadTranscriptLibArtifact();
  const libHash = await walletClient.deployContract({ abi: libArtifact.abi, bytecode: libArtifact.bytecode.object });
  const libAddress = (await publicClient.waitForTransactionReceipt({ hash: libHash })).contractAddress!;
  console.log(`ZKTranscriptLib: ${libAddress}`);

  const accVerifierArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'account_verifier.sol/HonkVerifier.json'), 'utf-8'));
  const storeVerifierArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'storage_verifier.sol/HonkVerifier.json'), 'utf-8'));

  console.log('Deploying AccountVerifier...');
  const accHash = await walletClient.deployContract({
    abi: accVerifierArtifact.abi,
    bytecode: linkLibrary(accVerifierArtifact.bytecode.object, libAddress) as Hex,
  });
  const accVerifierAddr = (await publicClient.waitForTransactionReceipt({ hash: accHash })).contractAddress!;

  console.log('Deploying StorageVerifier...');
  const storeHash = await walletClient.deployContract({
    abi: storeVerifierArtifact.abi,
    bytecode: linkLibrary(storeVerifierArtifact.bytecode.object, libAddress) as Hex,
  });
  const storeVerifierAddr = (await publicClient.waitForTransactionReceipt({ hash: storeHash })).contractAddress!;

  console.log('Deploying ScoreRegistry...');
  const registryArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'ScoreRegistry.sol/ScoreRegistry.json'), 'utf-8'));
  const regHash = await walletClient.deployContract({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode.object });
  const registryAddr = (await publicClient.waitForTransactionReceipt({ hash: regHash })).contractAddress!;

  console.log('Deploying CreditPolicy...');
  const policyArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'CreditPolicy.sol/CreditPolicy.json'), 'utf-8'));
  const axiomAddress = getAddress(process.env.AXIOM_V2_QUERY_ADDRESS || '0x83c8c0B395850bA55c830451Cfaca4F2A667a983');

  const policyHash = await walletClient.deployContract({
    abi: policyArtifact.abi,
    bytecode: policyArtifact.bytecode.object,
    args: [axiomAddress, accVerifierAddr, storeVerifierAddr],
  });
  const policyAddr = (await publicClient.waitForTransactionReceipt({ hash: policyHash })).contractAddress!;

  if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) {
    await publicClient.request({
      method: 'anvil_setBalance',
      params: [policyAddr, LOCAL_DEV_FUND_WEI],
    } as any);
    console.log(`Funded CreditPolicy for local testing: ${policyAddr}`);
  }

  console.log('\nDeployment Complete');
  console.log(`CREDIT_POLICY_ADDRESS=${policyAddr}`);
  console.log(`SCORE_REGISTRY_ADDRESS=${registryAddr}`);
  console.log(`ACCOUNT_VERIFIER_ADDRESS=${accVerifierAddr}`);
  console.log(`STORAGE_VERIFIER_ADDRESS=${storeVerifierAddr}`);

  mkdirSync(FRONTEND_PUBLIC_ROOT, { recursive: true });
  writeFileSync(
    DEPLOYMENT_JSON_PATH,
    JSON.stringify(
      {
        chainId: chain.id,
        rpcUrl,
        creditPolicyAddress: policyAddr,
        scoreRegistryAddress: registryAddr,
        accountVerifierAddress: accVerifierAddr,
        storageVerifierAddress: storeVerifierAddr,
        axiomV2QueryAddress: axiomAddress,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Wrote frontend deployment config: ${DEPLOYMENT_JSON_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});