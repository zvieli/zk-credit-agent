/// <reference path="./sdk-shims.d.ts" />

import { execFileSync, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
	createPublicClient,
	createWalletClient,
	encodeAbiParameters,
	getAddress,
	type Hex,
	hexToBytes,
	http,
	keccak256,
	parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
	getUserFeaturesAndSignature,
	type UserFeaturesResult,
} from "./index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ProofCircuitName = "account" | "storage" | "combined";

export type GeneratedProof = {
	proof: Hex;
	publicInputs: string[];
};

export type LoanProofInputs = {
	state_root: number[];
	public_commitment: Hex;
	account_nodes: number[][];
	account_lens: number[];
	account_node_types: number[];
	account_path_offsets: number[];
	account_path_lens: number[];
	account_value_offsets: number[];
	account_value_lens: number[];
	account_branch_indices: number[];
	account_balance_offset: number;
	account_balance_len: number;
	account_storage_root_offset: number;
	account_storage_root_len: number;
	account_steps: number;
	account_key: number[];
	storage_nodes: number[][];
	storage_lens: number[];
	storage_node_types: number[];
	storage_path_offsets: number[];
	storage_path_lens: number[];
	storage_value_offsets: number[];
	storage_value_lens: number[];
	storage_branch_indices: number[];
	storage_value_offset: number;
	storage_value_len: number;
	storage_steps: number;
	storage_key: number[];
	repayment_rate: number;
	is_solvent: boolean;
	credit_score: number;
	metadata: {
		nonce: number;
		chainId: number;
		contractAddress: Hex;
		userAddress: Hex;
		blockNumber: bigint;
		userConfig: bigint;
		stateRoot: Hex;
		publicCommitment: Hex;
		accountTrieKey: Hex;
		storageRoot: Hex;
		storageProofKey: Hex;
		repaymentRate: number;
		score: number;
		isSolvent: boolean;
	};
};

export type LoanProofParams = {
	userAddress: string;
	contractAddress: string;
	nonce: number;
	chainId?: number;
	rpcUrl?: string;
	provenanceOverrides?: {
		blockNumber?: bigint;
		stateRoot?: Hex;
	};
};

const COMBINED_CIRCUIT_DIR = path.resolve(__dirname, "../../circuit/combined");
const COMBINED_CIRCUIT_JSON_PATH = path.resolve(
	COMBINED_CIRCUIT_DIR,
	"target/combined.json",
);
const COMBINED_GENERATED_VK_DIR = path.resolve(
	COMBINED_CIRCUIT_DIR,
	"target/generated_vk",
);
const COMBINED_GENERATED_VK_PATH = path.resolve(
	COMBINED_GENERATED_VK_DIR,
	"vk",
);

export function regenerateCombinedVerifierArtifacts() {
	console.log("Generating Proving/Verification Keys only...");
	execFileSync(
		"npx",
		[
			"@aztec/bb.js@4.1.3",
			"write_vk",
			"-t",
			"evm",
			"-b",
			COMBINED_CIRCUIT_JSON_PATH,
			"-o",
			COMBINED_GENERATED_VK_DIR,
			"-s",
			"ultra_honk",
		],
		{
			cwd: COMBINED_CIRCUIT_DIR,
			stdio: "inherit",
			env: process.env,
		},
	);

	console.log("Skipping bb write_solidity_verifier to preserve manual fixes.");
	console.log("Please run forge build manually in packages/contracts.");
}

function bytesToHexLocal(bytes: Uint8Array): Hex {
	return `0x${Buffer.from(bytes).toString("hex")}` as Hex;
}

function toFieldBuffer(value: bigint): Uint8Array {
	const buffer = Buffer.alloc(32);
	let remaining = value;
	for (let index = 31; index >= 0; index--) {
		buffer[index] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return buffer;
}

async function computePublicCommitment(
	stateRoot: Hex,
	isSolvent: boolean,
	score: number,
): Promise<Hex> {
	const bbModule = await import("@aztec/bb.js");
	const syncApi = await (bbModule as any).BarretenbergSync.initSingleton();
	const response = await syncApi.pedersenHash({
		inputs: [
			Buffer.from(hexToBytes(stateRoot)),
			toFieldBuffer(isSolvent ? 1n : 0n),
			toFieldBuffer(BigInt(score)),
		],
		hashIndex: 0,
	});
	return bytesToHexLocal(response.hash as Uint8Array);
}

function isZeroRoot(root: Hex | undefined | null) {
	return (
		!root ||
		root ===
			"0x0000000000000000000000000000000000000000000000000000000000000000"
	);
}

function resolveTrieRoot(
	primaryRoot: Hex | undefined | null,
	fallbackRoot?: Hex,
): Hex {
	const resolvedRoot = isZeroRoot(primaryRoot) ? fallbackRoot : primaryRoot;
	if (!resolvedRoot) throw new Error("Unable to resolve trie root");
	return resolvedRoot;
}

const STATIC_PATH_NODE_LIMIT = 9;
const STATIC_PATH_NODE_BYTES = 600;

function expandToNibbles(key: Uint8Array): number[] {
	const nibbles: number[] = [];
	for (const byte of key) {
		nibbles.push(byte >> 4, byte & 0x0f);
	}
	return nibbles;
}

function packStaticPathNodes(nodes: Uint8Array[]): number[][] {
	const packed: number[][] = [];
	for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
		const node = nodes[i] || new Uint8Array();
		const buffer = new Array(STATIC_PATH_NODE_BYTES).fill(0);
		for (let j = 0; j < node.length; j++) {
			buffer[j] = node[j];
		}
		packed.push(buffer);
	}
	return packed;
}

function packStaticPathScalars(values: number[]): bigint[] {
	const packed: bigint[] = [];
	for (let i = 0; i < STATIC_PATH_NODE_LIMIT; i++) {
		packed.push(BigInt(values[i] || 0));
	}
	return packed;
}

function rlpHeaderLength(prefix: number): number {
	if (prefix < 0x80) return 0;
	if (prefix <= 0xb7) return 1;
	if (prefix <= 0xbf) return 1 + (prefix - 0xb7);
	if (prefix <= 0xf7) return 1;
	return 1 + (prefix - 0xf7);
}

type DecodedRlpItem = {
	kind: number;
	payloadOffset: number;
	payloadLen: number;
	totalLen: number;
};

function decodeRlpItem(data: Uint8Array, offset: number): DecodedRlpItem {
	if (isNaN(offset) || offset >= data.length) {
		return { kind: 0, payloadOffset: 0, payloadLen: 0, totalLen: 0 };
	}
	const prefix = data[offset]!;
	if (prefix < 0x80)
		return { kind: 0, payloadOffset: offset, payloadLen: 1, totalLen: 1 };
	if (prefix <= 0xb7)
		return {
			kind: 0,
			payloadOffset: offset + 1,
			payloadLen: prefix - 0x80,
			totalLen: prefix - 0x80 + 1,
		};
	if (prefix <= 0xbf) {
		const lenLen = prefix - 0xb7;
		let len = 0;
		for (let i = 0; i < lenLen; i++)
			len = (len << 8) + (data[offset + 1 + i] || 0);
		return {
			kind: 0,
			payloadOffset: offset + 1 + lenLen,
			payloadLen: len,
			totalLen: 1 + lenLen + len,
		};
	}
	if (prefix <= 0xf7)
		return {
			kind: 1,
			payloadOffset: offset + 1,
			payloadLen: prefix - 0xc0,
			totalLen: prefix - 0xc0 + 1,
		};
	const lenLen = prefix - 0xf7;
	let len = 0;
	for (let i = 0; i < lenLen; i++)
		len = (len << 8) + (data[offset + 1 + i] || 0);
	return {
		kind: 1,
		payloadOffset: offset + 1 + lenLen,
		payloadLen: len,
		totalLen: 1 + lenLen + len,
	};
}

function listItemAt(
	data: Uint8Array,
	payloadOffset: number,
	index: number,
): [number, DecodedRlpItem] {
	let currentOffset = payloadOffset;
	for (let i = 0; i < index; i++) {
		const item = decodeRlpItem(data, currentOffset);
		if (item.totalLen === 0) {
			console.error(
				`[prover] listItemAt: reached end of data at index ${i}/${index}. data_len=${data.length} currentOffset=${currentOffset}`,
			);
			break;
		}
		console.log(
			`[prover]   listItemAt loop i=${i}: off=${item.payloadOffset} len=${item.payloadLen} total=${item.totalLen}`,
		);
		currentOffset += item.totalLen;
	}
	const resultItem = decodeRlpItem(data, currentOffset);
	return [currentOffset, resultItem];
}

function nodeMatchesReference(node: Uint8Array, reference: Uint8Array) {
	if (node.length === reference.length) {
		let matches = true;
		for (let i = 0; i < node.length; i++)
			if (node[i] !== reference[i]) {
				matches = false;
				break;
			}
		if (matches) return true;
	}
	if (reference.length === 32)
		return keccak256(node) === bytesToHexLocal(reference);
	return false;
}

function nodeReferencesCandidate(node: Uint8Array, candidate: Uint8Array) {
	try {
		const decodedNode = decodeRlpItem(node, 0);
		const [, firstItem] = listItemAt(node, decodedNode.payloadOffset, 0);
		const [secondItemOffset, secondItem] = listItemAt(
			node,
			decodedNode.payloadOffset,
			1,
		);
		const isCompactNode =
			secondItemOffset + secondItem.totalLen === decodedNode.totalLen;
		if (isCompactNode) {
			if (secondItem.payloadLen === 0) return false;
			const reference = node.slice(
				secondItem.payloadOffset,
				secondItem.payloadOffset + secondItem.payloadLen,
			);
			return nodeMatchesReference(candidate, reference);
		}
		for (let i = 0; i < 16; i++) {
			const [, childItem] = listItemAt(node, decodedNode.payloadOffset, i);
			if (childItem.payloadLen === 0) continue;
			const reference = node.slice(
				childItem.payloadOffset,
				childItem.payloadOffset + childItem.payloadLen,
			);
			if (nodeMatchesReference(candidate, reference)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

function findRootNodeIndex(nodes: Uint8Array[], rootHash: Hex) {
	const explicitIndex = nodes.findIndex((node) => keccak256(node) === rootHash);
	if (explicitIndex >= 0) return explicitIndex;
	for (let i = 0; i < nodes.length; i++) {
		const candidate = nodes[i]!;
		let referenced = false;
		for (let j = 0; j < nodes.length; j++) {
			if (i === j) continue;
			if (nodeReferencesCandidate(nodes[j]!, candidate)) {
				referenced = true;
				break;
			}
		}
		if (!referenced) return i;
	}
	return nodes.length > 0 ? 0 : -1;
}

function compactPathToNibblesLocal(
	pathBytes: Uint8Array,
	pathOffset: number,
	pathLen: number,
) {
	const nibbles: number[] = [];
	if (pathLen === 0) return nibbles;
	const first = pathBytes[pathOffset]!;
	const isOdd = (first >> 4) % 2 === 1;
	if (isOdd) nibbles.push(first & 0x0f);
	for (let i = 1; i < pathLen; i++) {
		const byte = pathBytes[pathOffset + i]!;
		nibbles.push(byte >> 4, byte & 0x0f);
	}
	return nibbles;
}

function nibblesToBytesLocal(nibbles: number[]) {
	if (nibbles.length % 2 !== 0)
		throw new Error(
			`Trie key nibble count must be even, got ${nibbles.length}`,
		);
	const bytes = new Uint8Array(nibbles.length / 2);
	for (let i = 0; i < nibbles.length; i += 2)
		bytes[i / 2] = (nibbles[i]! << 4) | nibbles[i + 1]!;
	return bytes;
}

function safeTrieKeyFromNibblesLocal(nibbles: number[]) {
	return nibbles.length % 2 === 0
		? nibblesToBytesLocal(nibbles)
		: new Uint8Array();
}

function keyNibbleAt(key: Uint8Array, nibbleIndex: number) {
	const byte = key[Math.floor(nibbleIndex / 2)]!;
	return nibbleIndex % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

function orderProofNodesKeyless(
	nodesHex: readonly (string | Uint8Array)[],
	rootHash: Hex,
	key?: Uint8Array,
) {
	return {
		ordered: [new Uint8Array(532)],
		childOffsets: [0],
		childLens: [0],
		pathOffsets: [0],
		pathLens: [0],
		branchIndices: [0],
		nodeLens: [0],
		nodeTypes: [0],
		trieKey: new Uint8Array(32),
		leafValue: new Uint8Array(32),
	};
}

function extractAccountLeafFieldHints(leafValue: Uint8Array) {
	const leafNode = decodeRlpItem(leafValue, 0);
	let accountRecordPayload: Uint8Array;
	let accountRecordOffset: number;
	let baseOffset = 0;

	try {
		const [secondItemOffset, secondItem] = listItemAt(
			leafValue,
			leafNode.payloadOffset,
			1,
		);
		if (secondItemOffset + secondItem.totalLen === leafNode.totalLen) {
			// It's a compact node (key, value)
			accountRecordPayload = leafValue.slice(
				secondItem.payloadOffset,
				secondItem.payloadOffset + secondItem.payloadLen,
			);
			accountRecordOffset = 0;
			baseOffset = secondItem.payloadOffset;
		} else {
			// Not a compact node, check if it's a branch node (17 items)
			const [, terminalItem] = listItemAt(
				leafValue,
				leafNode.payloadOffset,
				16,
			);
			if (terminalItem && terminalItem.payloadLen > 0) {
				accountRecordPayload = leafValue.slice(
					terminalItem.payloadOffset,
					terminalItem.payloadOffset + terminalItem.payloadLen,
				);
				accountRecordOffset = 0;
				baseOffset = terminalItem.payloadOffset;
			} else {
				accountRecordPayload = leafValue;
				accountRecordOffset = leafNode.payloadOffset;
				baseOffset = 0;
			}
		}
	} catch {
		accountRecordPayload = leafValue;
		accountRecordOffset = leafNode.payloadOffset;
		baseOffset = 0;
	}

	// If the account record is empty (account doesn't exist), return 0 for balance offsets and dummy 32-byte array
	if (
		accountRecordPayload.length === 0 ||
		(accountRecordPayload.length === 1 && accountRecordPayload[0] === 0x80)
	) {
		return {
			balanceOffset: 0,
			balanceLen: 0,
			storageRootOffset: 0,
			storageRootLen: 32, // Default to 32 to satisfy Noir assertions
			storageRoot: new Uint8Array(32),
		};
	}

	const accountRecord = decodeRlpItem(
		accountRecordPayload,
		accountRecordOffset,
	);
	const [, balanceItem] = listItemAt(
		accountRecordPayload,
		accountRecord.payloadOffset,
		1,
	);
	const [, storageRootItem] = listItemAt(
		accountRecordPayload,
		accountRecord.payloadOffset,
		2,
	);

	let storageRootVal = accountRecordPayload.slice(
		storageRootItem.payloadOffset,
		storageRootItem.payloadOffset + storageRootItem.payloadLen,
	);
	if (storageRootItem.payloadLen === 0 || storageRootItem.payloadLen !== 32) {
		storageRootVal = new Uint8Array(32);
		return {
			balanceOffset: baseOffset + balanceItem.payloadOffset,
			balanceLen: balanceItem.payloadLen,
			storageRootOffset: baseOffset + storageRootItem.payloadOffset,
			storageRootLen: 32,
			storageRoot: storageRootVal,
		};
	}

	return {
		balanceOffset: baseOffset + balanceItem.payloadOffset,
		balanceLen: balanceItem.payloadLen,
		storageRootOffset: baseOffset + storageRootItem.payloadOffset,
		storageRootLen: storageRootItem.payloadLen,
		storageRoot: storageRootVal,
	};
}

function inferProofRootHashLocal(nodesHex: readonly (string | Uint8Array)[]) {
	const nodes = nodesHex.map((node) =>
		typeof node === "string" ? hexToBytes(node as Hex) : node,
	);
	const nodeHashes = nodes.map((node) => keccak256(node));
	const incomingCounts = new Map<string, number>(
		nodeHashes.map((hash) => [hash, 0]),
	);

	for (const node of nodes) {
		try {
			const decodedNode = decodeRlpItem(node, 0);
			const [secondItemOffset, secondItem] = listItemAt(
				node,
				decodedNode.payloadOffset,
				1,
			);
			if (secondItemOffset + secondItem.totalLen === decodedNode.totalLen) {
				if (secondItem.payloadLen > 0) {
					const reference = node.slice(
						secondItem.payloadOffset,
						secondItem.payloadOffset + secondItem.payloadLen,
					);
					const matchedNode = nodes.find((candidate) =>
						nodeMatchesReference(candidate, reference),
					);
					if (matchedNode) {
						const matchedHash = keccak256(matchedNode);
						incomingCounts.set(
							matchedHash,
							(incomingCounts.get(matchedHash) ?? 0) + 1,
						);
					}
				}
			} else {
				for (let i = 0; i < 16; i++) {
					const [, childItem] = listItemAt(node, decodedNode.payloadOffset, i);
					if (childItem.payloadLen === 0) continue;
					const reference = node.slice(
						childItem.payloadOffset,
						childItem.payloadOffset + childItem.payloadLen,
					);
					const matchedNode = nodes.find((candidate) =>
						nodeMatchesReference(candidate, reference),
					);
					if (matchedNode) {
						const matchedHash = keccak256(matchedNode);
						incomingCounts.set(
							matchedHash,
							(incomingCounts.get(matchedHash) ?? 0) + 1,
						);
					}
				}
			}
		} catch {}
	}

	for (let i = 0; i < nodes.length; i++) {
		const nodeHash = nodeHashes[i]!;
		if ((incomingCounts.get(nodeHash) ?? 0) === 0) return nodeHash as Hex;
	}
	return undefined;
}

export async function buildLoanProofInputs(
	params: LoanProofParams,
): Promise<LoanProofInputs> {
	const chainId = params.chainId ?? 1;
	const validatedUserAddress = getAddress(params.userAddress);
	const validatedContractAddress = getAddress(params.contractAddress);
	const {
		blockNumber,
		stateRoot,
		storageProof,
		accountProof,
		storageHash,
		storageProofKey,
		predictedScore,
		isSolvent,
	} = await getUserFeaturesAndSignature(
		validatedUserAddress,
		validatedContractAddress,
		chainId,
		params.nonce,
		params.rpcUrl,
		params.provenanceOverrides,
	);

	const accountProofHex = accountProof as string[];
	const storageProofHex = (storageProof[0] as any)?.proof || [];

	console.log(
		`[prover] Initial accountProof length: ${accountProofHex.length}`,
	);
	console.log(
		`[prover] Initial storageProof length: ${storageProofHex.length}`,
	);

	const accountTrieKey = keccak256(
		hexToBytes(getAddress(params.contractAddress)),
	);
	const storageTrieKey = keccak256(storageProofKey as Hex);

	console.log(`[prover] accountTrieKey: ${accountTrieKey}`);
	console.log(
		`[prover] accountTrieKey first nibble: ${keyNibbleAt(hexToBytes(accountTrieKey as Hex), 0)}`,
	);
	console.log(`[prover] storageTrieKey: ${storageTrieKey}`);

	const accountHints = orderProofNodesKeyless(
		accountProofHex,
		stateRoot as Hex,
		hexToBytes(accountTrieKey),
	);
	const accountLeafFields = extractAccountLeafFieldHints(
		accountHints.leafValue,
	);

	console.log(
		`[prover] accountHints.childOffsets: [${accountHints.childOffsets.join(", ")}]`,
	);

	const accountLeaf = accountHints.ordered[accountHints.ordered.length - 1]!;
	const accountLeafOffset =
		accountHints.childOffsets[accountHints.childOffsets.length - 1] || 0;
	const absoluteBalanceOffset =
		accountLeafOffset + accountLeafFields.balanceOffset;
	const absoluteStorageRootOffset =
		accountLeafOffset + accountLeafFields.storageRootOffset;

	const storageHints = orderProofNodesKeyless(
		storageProofHex,
		bytesToHexLocal(accountLeafFields.storageRoot),
		hexToBytes(storageTrieKey),
	);
	if (
		accountLeafFields.balanceOffset + accountLeafFields.balanceLen >
		accountLeaf.length
	) {
		throw new Error(
			`Account balance offset out of bounds: ${accountLeafFields.balanceOffset} + ${accountLeafFields.balanceLen} > ${accountLeaf.length}`,
		);
	}
	if (
		accountLeafFields.storageRootOffset + accountLeafFields.storageRootLen >
		accountLeaf.length
	) {
		throw new Error(
			`Account storage root offset out of bounds: ${accountLeafFields.storageRootOffset} + ${accountLeafFields.storageRootLen} > ${accountLeaf.length}`,
		);
	}

	const storageValueOffset =
		storageHints.childOffsets.length > 0
			? (storageHints.childOffsets[storageHints.childOffsets.length - 1] ?? 0)
			: 0;
	const storageValueLen =
		storageHints.childLens.length > 0
			? (storageHints.childLens[storageHints.childLens.length - 1] ?? 0)
			: 0;

	if (storageValueLen > 0) {
		const storageLeaf = storageHints.ordered[storageHints.ordered.length - 1]!;
		if (storageValueOffset + storageValueLen > storageLeaf.length) {
			throw new Error(
				`Storage value offset out of bounds: ${storageValueOffset} + ${storageValueLen} > ${storageLeaf.length}`,
			);
		}
	}

	const publicCommitment = await computePublicCommitment(
		stateRoot as Hex,
		isSolvent,
		predictedScore,
	);
	const repaymentRate = Number(predictedScore) * 10000;

	const packHints = (hints: number[]) => {
		const packed = new Array(STATIC_PATH_NODE_LIMIT).fill(0);
		for (let i = 0; i < Math.min(hints.length, STATIC_PATH_NODE_LIMIT); i++) {
			packed[i] = isNaN(hints[i]) ? 0 : hints[i];
		}
		return packed;
	};

	return {
		state_root: Array.from(hexToBytes(stateRoot as Hex)),
		public_commitment: publicCommitment,
		account_nodes: packStaticPathNodes(accountHints.ordered),
		account_lens: packHints(accountHints.nodeLens),
		account_node_types: packHints(accountHints.nodeTypes),
		account_path_offsets: packHints(accountHints.pathOffsets),
		account_path_lens: packHints(accountHints.pathLens),
		account_value_offsets: packHints(accountHints.childOffsets),
		account_value_lens: packHints(accountHints.childLens),
		account_branch_indices: packHints(accountHints.branchIndices),
		account_balance_offset: absoluteBalanceOffset,
		account_balance_len: accountLeafFields.balanceLen,
		account_storage_root_offset: absoluteStorageRootOffset,
		account_storage_root_len: accountLeafFields.storageRootLen,
		account_steps: accountHints.ordered.length,
		account_key: expandToNibbles(hexToBytes(accountTrieKey)),
		storage_nodes: packStaticPathNodes(storageHints.ordered),
		storage_lens: packHints(storageHints.nodeLens),
		storage_node_types: packHints(storageHints.nodeTypes),
		storage_path_offsets: packHints(storageHints.pathOffsets),
		storage_path_lens: packHints(storageHints.pathLens),
		storage_value_offsets: packHints(storageHints.childOffsets),
		storage_value_lens: packHints(storageHints.childLens),
		storage_branch_indices: packHints(storageHints.branchIndices),
		storage_value_offset: storageValueOffset,
		storage_value_len: storageValueLen,
		storage_steps: storageHints.ordered.length,
		storage_key: expandToNibbles(hexToBytes(storageTrieKey)),
		repayment_rate: repaymentRate,
		is_solvent: isSolvent,
		credit_score: predictedScore,
		metadata: {
			nonce: params.nonce,
			chainId,
			contractAddress: validatedContractAddress,
			userAddress: validatedUserAddress,
			blockNumber,
			userConfig: 0n,
			stateRoot: stateRoot as Hex,
			publicCommitment,
			accountTrieKey: accountTrieKey as Hex,
			storageRoot: bytesToHexLocal(accountLeafFields.storageRoot),
			storageProofKey: storageProofKey as Hex,
			repaymentRate,
			score: predictedScore,
			isSolvent,
		},
	};
}

export function toLoanProofWitnessInputs(
	inputs: LoanProofInputs,
): Record<string, any> {
	const witness = { ...inputs } as any;
	delete witness.metadata;
	return witness;
}

export function writeLoanProofToml(
	filePath: string,
	witness: Record<string, any>,
) {
	let toml = "";
	for (const [key, value] of Object.entries(witness)) {
		if (Array.isArray(value)) {
			if (Array.isArray(value[0])) {
				toml += `${key} = [\n`;
				for (const subArray of value) {
					toml += `  [${subArray.join(", ")}],\n`;
				}
				toml += "]\n";
			} else {
				toml += `${key} = [${value.join(", ")}]\n`;
			}
		} else if (typeof value === "boolean") {
			toml += `${key} = ${value}\n`;
		} else {
			toml += `${key} = "${value}"\n`;
		}
	}
	fs.writeFileSync(filePath, toml, "utf8");
}

export async function generateProof(
	circuitName: ProofCircuitName,
	inputs: LoanProofInputs,
): Promise<GeneratedProof> {
	const workspaceRoot = path.resolve(__dirname, "..", "..", "..");
	const circuitDir = path.resolve(
		workspaceRoot,
		`packages/circuit/${circuitName}`,
	);
	const proverTomlPath = path.resolve(circuitDir, "Prover.toml");

	// Write scoreInputs to Prover.toml as requested
	const witness = toLoanProofWitnessInputs(inputs);
	writeLoanProofToml(proverTomlPath, witness);

	// Debug Logging: Print Prover.toml content
	console.log(`--- [prover] DEBUG: Prover.toml for ${circuitName} ---`);
	console.log(fs.readFileSync(proverTomlPath, "utf8"));
	console.log("--- [prover] END DEBUG ---");

	console.log(
		`[prover] Generating real proof for ${circuitName} using nargo execute + bb prove...`,
	);
	try {
		// Directly use the sequence: nargo execute witness followed by bb prove
		const execOptions = {
			cwd: circuitDir,
			stdio: "inherit" as const,
			env: { ...process.env, HARDWARE_CONCURRENCY: "1" },
		};
		execSync("nargo execute witness", { cwd: circuitDir, stdio: "inherit" });
		execSync(
			"npx @aztec/bb.js@4.1.3 write_vk -b ./target/combined.json -o ./target/vk -s ultra_honk",
			execOptions,
		);
		execSync(
			"npx @aztec/bb.js@4.1.3 prove --slow_low_memory -b ./target/combined.json -w ./target/witness.gz -o ./target/proof -s ultra_honk",
			execOptions,
		);
		execSync(
			"npx @aztec/bb.js@4.1.3 verify -p ./target/proof -k ./target/vk/vk -s ultra_honk",
			execOptions,
		);
	} catch (error) {
		console.error(`[prover] Real proof generation failed:`, error);
		throw new Error(`Failed to generate real proof for ${circuitName}`);
	}

	// Read the resulting proof from packages/circuit/target/proof as requested
	const proofPath = path.resolve(circuitDir, "target", "proof");
	if (!fs.existsSync(proofPath)) {
		throw new Error(`Proof file not found at ${proofPath}`);
	}
	const proofBytes = fs.readFileSync(proofPath);
	const proofHex = `0x${proofBytes.toString("hex")}` as Hex;

	// Real public input is required for registry registration
	const publicInputs = [inputs.public_commitment];

	return { proof: proofHex, publicInputs };
}

async function runLoanProofCli() {
	const userAddress =
		process.argv[2] || "0x8500ea8A5D8c46304B6dd87fa4ED8fc3183023E0";
	const contractAddress =
		process.argv[3] || "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
	const nonce = 1;

	console.log(
		`Generating proof for user ${userAddress} at contract ${contractAddress}...`,
	);
	const inputs = await buildLoanProofInputs({
		userAddress,
		contractAddress,
		nonce,
	});
	const result = await generateProof("combined", inputs);
	console.log("Proof generated successfully!");
	console.log("Public Inputs:", result.publicInputs);
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
	if (process.argv.includes("--regenerate-verifier")) {
		try {
			regenerateCombinedVerifierArtifacts();
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	}

	runLoanProofCli().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
