import { createPublicClient, http, keccak256, getAddress, parseAbiItem, encodeAbiParameters, parseAbiParameters } from 'viem';
import { mainnet } from 'viem/chains';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { buildSendQuery, getAxiomV2QueryAddress } from '@axiom-crypto/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const AAVE_V3_POOL_ADDRESS = getAddress(process.env.AAVE_V3_POOL_ADDRESS || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2');
export const AAVE_USER_CONFIG_SLOT = 53n;

export function getAaveUserConfigStorageSlot(userAddress: string) {
  return keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(userAddress), AAVE_USER_CONFIG_SLOT]));
}

export function evaluateAaveUserConfig(userConfig: bigint) {
  let hasCollateral = false;
  let hasDebt = false;

  for (let assetIndex = 0; assetIndex < 128; assetIndex++) {
    const collateralBit = (userConfig >> BigInt(assetIndex * 2 + 1)) & 1n;
    const debtBit = (userConfig >> BigInt(assetIndex * 2)) & 1n;

    if (collateralBit === 1n) {
      hasCollateral = true;
    }

    if (debtBit === 1n) {
      hasDebt = true;
    }

    if (hasCollateral && hasDebt) {
      break;
    }
  }

  return {
    hasCollateral,
    hasDebt,
    isSolvent: hasCollateral && !hasDebt,
  };
}

function resolveProofRpcUrl(explicitRpcUrl?: string) {
  if (explicitRpcUrl) {
    return explicitRpcUrl;
  }

  if (process.env.PROOF_RPC_URL) {
    return process.env.PROOF_RPC_URL;
  }

  if (process.env.RPC_URL) {
    return process.env.RPC_URL;
  }

  if (process.env.ALCHEMY_API_KEY) {
    return `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
  }

  return 'http://127.0.0.1:8545';
}

const poolAbi = [
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getUserAccountData",
    "outputs": [
      { "internalType": "uint256", "name": "totalCollateralBase", "type": "uint256" },
      { "internalType": "uint256", "name": "totalDebtBase", "type": "uint256" },
      { "internalType": "uint256", "name": "availableBorrowsBase", "type": "uint256" },
      { "internalType": "uint256", "name": "currentLiquidationThreshold", "type": "uint256" },
      { "internalType": "uint256", "name": "ltv", "type": "uint256" },
      { "internalType": "uint256", "name": "healthFactor", "type": "uint256" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "address", "name": "user", "type": "address" }],
    "name": "getUserConfiguration",
    "outputs": [{ "internalType": "struct DataTypes.UserConfigurationMap", "name": "", "type": "tuple", "components": [{ "internalType": "uint256", "name": "data", "type": "uint256" }] }],
    "stateMutability": "view",
    "type": "function"
  }
] as const;

function createProofPublicClient(rpcUrl?: string) {
  return createPublicClient({
    chain: mainnet,
    transport: http(resolveProofRpcUrl(rpcUrl), {
      timeout: 300000,
    }),
  });
}

export function encodeAxiomStateRootCallbackData(blockNumber: bigint) {
  return encodeAbiParameters(parseAbiParameters('uint256'), [blockNumber]);
}

export async function buildAndSendAxiomStateRootQuery(input: {
  chainId: number;
  rpcUrl: string;
  caller: string;
  callbackTarget: string;
  blockNumber: bigint;
  dataQuery: any[];
  computeQuery: any;
  options?: any;
  target?: { chainId: number; rpcUrl: string };
  axiomV2QueryAddress?: string;
  mock?: boolean;
  sendQuery?: (payload: any) => Promise<unknown>;
}) {
  const axiomV2QueryAddress = input.axiomV2QueryAddress ?? getAxiomV2QueryAddress(String(input.chainId));
  const sendQueryArgs = await buildSendQuery({
    chainId: String(input.chainId),
    rpcUrl: input.rpcUrl,
    axiomV2QueryAddress,
    dataQuery: input.dataQuery,
    computeQuery: input.computeQuery,
    callback: {
      target: getAddress(input.callbackTarget),
      extraData: encodeAxiomStateRootCallbackData(input.blockNumber),
    },
    caller: getAddress(input.caller),
    mock: input.mock ?? true,
    options: input.options ?? {},
    target: input.target,
  } as any);

  if (input.sendQuery) {
    const txHash = await input.sendQuery(sendQueryArgs);
    return { ...sendQueryArgs, txHash };
  }

  return sendQueryArgs;
}

export async function getUserFeaturesAndSignature(
  userAddress: string,
  contractAddress: string,
  chainId: number,
  nonce: number,
  rpcUrl?: string,
  overrides?: {
    blockNumber?: bigint;
    stateRoot?: `0x${string}`;
    storageProofAddress?: string;
    storageProofSlot?: `0x${string}`;
  }
) {
  const publicClient = createProofPublicClient(rpcUrl);
  const validatedAddress = getAddress(userAddress);
  const validatedContract = getAddress(contractAddress);
  
  const data = await publicClient.readContract({
    address: AAVE_V3_POOL_ADDRESS,
    abi: poolAbi,
    functionName: 'getUserAccountData',
    args: [validatedAddress],
  });

  const userConfigResult = await publicClient.readContract({
    address: AAVE_V3_POOL_ADDRESS,
    abi: poolAbi,
    functionName: 'getUserConfiguration',
    args: [validatedAddress],
  }) as { data?: bigint } | bigint;

  const userConfig = typeof userConfigResult === 'bigint' ? userConfigResult : userConfigResult.data ?? 0n;
  const userConfigState = evaluateAaveUserConfig(userConfig);

  const ethBalance = await publicClient.getBalance({ address: validatedAddress });

  const normalizeUSD = (val: bigint) => Number(val / 100000000n) || 0;
  const normalizeHF = (val: bigint) => Number(val / 1000000000000000000n) || 0;
  const toUint32 = (num: number) => Math.max(0, Math.min(Math.floor(num), 0xFFFFFFFF));
  const maxDiversity = 100;

  const repayment_consistency_score = Math.min(Number(ethBalance / 10n**17n) * 10, 500);

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const erc20Abi = [{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}] as const;

  const usdcBal = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [validatedAddress] });
  const usdtBal = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [validatedAddress] });

  const latestBlock = overrides?.blockNumber
    ? await publicClient.getBlock({ blockNumber: overrides.blockNumber })
    : await publicClient.getBlock({ blockTag: 'latest' });
  const requestedBlockNumber = overrides?.blockNumber ?? latestBlock.number;
  const proofBlockNumber = requestedBlockNumber > 0n ? requestedBlockNumber - 1n : requestedBlockNumber;
  const proofBlock = await publicClient.getBlock({ blockNumber: proofBlockNumber });
  const blockNumber = proofBlock.number;
  const stateRoot = overrides?.stateRoot ?? proofBlock.stateRoot;

  let past_liquidations_count = 0;
  try {
      const logs = await publicClient.getLogs({
        address: AAVE_V3_POOL_ADDRESS,
        event: parseAbiItem('event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)'),
        args: { user: validatedAddress },
        fromBlock: blockNumber > 10n ? blockNumber - 10n : 0n,
        toBlock: "latest"
      });
      past_liquidations_count = logs.length;
  } catch (e) {
      console.log('Failed to fetch logs, defaulting to 0');
  }

  const colBase = normalizeUSD(data[0]);
  const stablecoin_balance = Number(usdcBal) / 1e6 + Number(usdtBal) / 1e6;
  const stablecoin_ratio = colBase > 0 ? Math.min(100, Math.floor((stablecoin_balance / colBase) * 100)) : 0;
  const collateral = Number(data[0] / 100000000n) || 0;
  const totalDebt = Number(data[1] / 100000000n) || 0;
  const netEquity = collateral - totalDebt;
  const diversity = Math.min(Math.floor(normalizeHF(data[5])), 100);
  const hfBonus = diversity > 3 ? 150 : diversity * 50;
  const stableBonus = stablecoin_ratio > 50 ? 100 : 0;
  const historical_bonus = Math.min(Math.floor(Number(ethBalance / 10n**17n)) * 10, 500);
  let walletWealth = historical_bonus + stableBonus;
  let penalty = past_liquidations_count * 300;
  if (totalDebt === 0) penalty += 200;
  const predictedScore = userConfig === 0n
    ? 0
    : Math.max(0, Math.min(Math.floor((netEquity / 20) + hfBonus + walletWealth - penalty), 1000));

  let features: [number, number, number, number, number, number, number, number] = [
    toUint32(normalizeUSD(data[0])), // totalCollateral (repayment_rate)
    toUint32(normalizeUSD(data[1])), // totalDebt (liquidations)
    toUint32(normalizeUSD(data[2])), // availableBorrows (loan_count)
    toUint32(Number(data[4] / 100n)), // ltv (avg_pos_size)
    toUint32(normalizeHF(data[5])), // healthFactor (diversity)
    toUint32(past_liquidations_count), 
    toUint32(stablecoin_ratio),
    toUint32(repayment_consistency_score)
  ];
  features[4] = Math.min(features[4], maxDiversity);

  // Storage Proof Calculation
  const storageAddress = overrides?.storageProofAddress ? getAddress(overrides.storageProofAddress) : AAVE_V3_POOL_ADDRESS;
  const storageSlot = overrides?.storageProofSlot ?? getAaveUserConfigStorageSlot(validatedAddress);
  const proof = await publicClient.getProof({
    address: storageAddress,
    storageKeys: [storageSlot],
    blockNumber: blockNumber
  });

  const proofAny = proof as any;
  const storageHash = proof.storageHash;
  const storageProofKey = storageSlot;
  const storageProofValue = proofAny.storageProof?.[0]?.value ?? `0x${userConfig.toString(16)}`;

  return { 
    features, 
    predictedScore,
    blockNumber,
    stateRoot,
    storageProof: proof.storageProof ?? [],
    accountProof: proof.accountProof ?? [],
    storageHash: storageHash as `0x${string}`,
    storageProofKey: storageProofKey as `0x${string}`,
    storageValue: storageProofValue as `0x${string}`,
    storageSlot,
    userConfig,
    hasCollateral: userConfigState.hasCollateral,
    hasDebt: userConfigState.hasDebt,
    isSolvent: userConfigState.isSolvent,
  };
}
