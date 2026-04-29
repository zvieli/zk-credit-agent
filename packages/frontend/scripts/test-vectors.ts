import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildLoanProofInputs, generateProof } from '../../backend/src/prover.ts';

function isMainModule() {
  const entryFile = process.argv[1];
  if (!entryFile) {
    return false;
  }

  return fileURLToPath(import.meta.url) === path.resolve(entryFile);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Usage: npm run test:vectors [-- --help]');
    console.log('Environment: BORROWER_ADDRESS, CREDIT_POLICY_ADDRESS, SCORE_REGISTRY_ADDRESS, RPC_URL, CHAIN_ID, NONCE');
    return;
  }

  const deploymentPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/deployment.json');
  const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8')) as {
    chainId?: number;
    rpcUrl?: string;
    creditPolicyAddress?: string;
    scoreRegistryAddress?: string;
  };

  const borrowerAddress = process.env.BORROWER_ADDRESS ?? '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
  const creditPolicyAddress = process.env.CREDIT_POLICY_ADDRESS ?? process.env.VITE_CREDIT_POLICY_ADDRESS ?? deployment.creditPolicyAddress;
  const scoreRegistryAddress = process.env.SCORE_REGISTRY_ADDRESS ?? process.env.VITE_SCORE_REGISTRY_ADDRESS ?? deployment.scoreRegistryAddress;
  const rpcUrl = process.env.RPC_URL ?? process.env.VITE_RPC_URL ?? deployment.rpcUrl ?? 'http://127.0.0.1:8545';
  const chainId = 1;
  const nonce = process.env.NONCE ? Number(process.env.NONCE) : Math.floor(Date.now() / 1000) >>> 0;

  if (!creditPolicyAddress) {
    throw new Error('Missing CREDIT_POLICY_ADDRESS or VITE_CREDIT_POLICY_ADDRESS');
  }

  const inputs = await buildLoanProofInputs({
    userAddress: borrowerAddress,
    contractAddress: creditPolicyAddress,
    nonce,
    chainId,
    scoreRegistryAddress: scoreRegistryAddress || undefined,
    rpcUrl,
  });

  const combinedProof = await generateProof('combined', inputs);

  const summary = {
    borrowerAddress,
    chainId,
    blockNumber: inputs.metadata.blockNumber.toString(),
    score: inputs.metadata.score,
    isSolvent: inputs.metadata.isSolvent,
    combinedPublicInputs: combinedProof.publicInputs.length,
    combinedProof: combinedProof.proof,
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
