import { createWalletClient, createPublicClient, http, getAddress, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
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
  join(CONTRACTS_OUT, 'combined_verifier.sol/ZKTranscriptLib.json'),
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
  
  const anvil = {
    ...mainnet,
    id: 31337,
  };
  const chain = rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost') ? anvil : mainnet;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) {
    await publicClient.request({
      method: 'anvil_setBalance',
      params: [account.address, '0x3635c9adc5dea00000'], // 1000 ETH
    } as any);
    console.log(`Funded deployment account for local testing: ${account.address}`);
  }

  console.log(`Starting deployment from: ${account.address}`);

  console.log('Deploying ZKTranscriptLib...');
  const libArtifact = loadTranscriptLibArtifact();
  const libHash = await walletClient.deployContract({ 
    abi: libArtifact.abi, 
    bytecode: libArtifact.bytecode.object,
    gas: 30_000_000n,
  });
  const libAddress = (await publicClient.waitForTransactionReceipt({ hash: libHash })).contractAddress!;
  console.log(`ZKTranscriptLib: ${libAddress}`);

  const combinedVerifierArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'combined_verifier.sol/HonkVerifier.json'), 'utf-8'));

  console.log('Deploying CombinedVerifier...');
  const combinedHash = await walletClient.deployContract({
    abi: combinedVerifierArtifact.abi,
    bytecode: linkLibrary(combinedVerifierArtifact.bytecode.object, libAddress) as Hex,
    gas: 30_000_000n,
  });
  const combinedVerifierAddr = (await publicClient.waitForTransactionReceipt({ hash: combinedHash })).contractAddress!;

  console.log('Deploying ScoreRegistry...');
  const registryArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'ScoreRegistry.sol/ScoreRegistry.json'), 'utf-8'));
  const regHash = await walletClient.deployContract({ 
    abi: registryArtifact.abi, 
    bytecode: registryArtifact.bytecode.object,
    gas: 10_000_000n,
  });
  const registryAddr = (await publicClient.waitForTransactionReceipt({ hash: regHash })).contractAddress!;

  console.log('Deploying CreditPolicy...');
  const policyArtifact = JSON.parse(readFileSync(join(CONTRACTS_OUT, 'CreditPolicy.sol/CreditPolicy.json'), 'utf-8'));
  const axiomAddress = getAddress(process.env.AXIOM_V2_QUERY_ADDRESS || '0x386121D50d8591873C8b8b15d666E3A3705978f8');

  const policyHash = await walletClient.deployContract({
    abi: policyArtifact.abi,
    bytecode: policyArtifact.bytecode.object,
    args: [axiomAddress, combinedVerifierAddr],
    gas: 10_000_000n,
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
  console.log(`COMBINED_VERIFIER_ADDRESS=${combinedVerifierAddr}`);

  mkdirSync(FRONTEND_PUBLIC_ROOT, { recursive: true });
  writeFileSync(
    DEPLOYMENT_JSON_PATH,
    JSON.stringify(
      {
        chainId: chain.id,
        rpcUrl,
        creditPolicyAddress: policyAddr,
        scoreRegistryAddress: registryAddr,
        combinedVerifierAddress: combinedVerifierAddr,
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