use common::{compute_solvent, decode_rlp_with_hint, verify_mpt_with_hints};
use ::keccak256::keccak256;

fn extract_storage_root(node: [u8; 600], storage_root_offset: u32, storage_root_len: u32) -> [u8; 32] {
    assert(storage_root_len == 32);

    decode_rlp_with_hint(node, storage_root_offset, storage_root_len)
}

fn main(
    state_root: [u8; 32],
    is_solvent: bool,
    credit_score: u32,
    public_commitment: pub Field,
    repayment_rate: u32,
    user_address: [u8; 20],
    nonce: u32,
    account_nodes: [[u8; 600]; 9],
    account_lens: [u32; 9],
    account_node_types: [u32; 9],
    account_path_offsets: [u32; 9],
    account_path_lens: [u32; 9],
    account_value_offsets: [u32; 9],
    account_value_lens: [u32; 9],
    account_branch_indices: [u32; 9],
    account_balance_offset: u32,
    account_balance_len: u32,
    account_storage_root_offset: u32,
    account_storage_root_len: u32,
    account_steps: u32,
    storage_key: [u8; 64],
    storage_nodes: [[u8; 600]; 9],
    storage_lens: [u32; 9],
    storage_node_types: [u32; 9],
    storage_path_offsets: [u32; 9],
    storage_path_lens: [u32; 9],
    storage_value_offsets: [u32; 9],
    storage_value_lens: [u32; 9],
    storage_branch_indices: [u32; 9],
    storage_value_offset: u32,
    storage_value_len: u32,
    storage_steps: u32,
) {
    // 1. Constrain that storage_key matches the double keccak256 hash of (user_address, 53)
    let mut slot_input = [0; 64];
    for i in 0..20 {
        slot_input[12 + i] = user_address[i];
    }
    slot_input[63] = 53; // Aave User Config slot
    let slot = keccak256(slot_input, 64);
    let trie_key = keccak256(slot, 32);

    let mut calculated_trie_key_nibbles = [0; 64];
    for i in 0..32 {
        calculated_trie_key_nibbles[i * 2] = trie_key[i] >> 4;
        calculated_trie_key_nibbles[i * 2 + 1] = trie_key[i] & 0x0f;
    }
    assert(calculated_trie_key_nibbles == storage_key);

    // 2. Compute public commitment using Keccak256
    let mut commitment_input = [0; 61];
    for i in 0..32 {
        commitment_input[i] = state_root[i];
    }
    commitment_input[32] = is_solvent as u8;
    commitment_input[33] = (credit_score >> 24) as u8;
    commitment_input[34] = (credit_score >> 16) as u8;
    commitment_input[35] = (credit_score >> 8) as u8;
    commitment_input[36] = credit_score as u8;
    for i in 0..20 {
        commitment_input[37 + i] = user_address[i];
    }
    commitment_input[57] = (nonce >> 24) as u8;
    commitment_input[58] = (nonce >> 16) as u8;
    commitment_input[59] = (nonce >> 8) as u8;
    commitment_input[60] = nonce as u8;

    let hash_result = keccak256(commitment_input, 61);
    
    // Convert first 31 bytes of hash to field element (safe for BN254 prime)
    let mut truncated_hash = [0; 32];
    for i in 0..31 {
        truncated_hash[i + 1] = hash_result[i];
    }
    let calculated_hash_field = Field::from_be_bytes::<32>(truncated_hash);
    assert(calculated_hash_field == public_commitment);

    // 3. MPT verification steps
    let AAVE_POOL_ADDR = [135, 135, 11, 202, 63, 63, 214, 51, 92, 63, 76, 232, 57, 45, 105, 53, 11, 79, 164, 226]; // 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
    let mut account_key_bytes = [0; 32];
    for i in 0..20 {
        account_key_bytes[12 + i] = AAVE_POOL_ADDR[i];
    }
    let account_trie_key = keccak256(account_key_bytes, 32);
    let mut account_key_nibbles = [0; 64];
    for i in 0..32 {
        account_key_nibbles[i * 2] = account_trie_key[i] >> 4;
        account_key_nibbles[i * 2 + 1] = account_trie_key[i] & 0x0f;
    }

    let _ = verify_mpt_with_hints(
        account_nodes,
        account_lens,
        account_node_types,
        account_path_offsets,
        account_path_lens,
        account_value_offsets,
        account_value_lens,
        account_branch_indices,
        account_steps,
        state_root,
        account_key_nibbles,
    );
    let account_leaf = account_nodes[account_steps - 1];
    assert(account_balance_offset < account_storage_root_offset);
    assert(account_balance_offset >= account_value_offsets[account_steps - 1]);
    assert(account_storage_root_offset >= account_value_offsets[account_steps - 1]);
    assert(account_balance_offset + account_balance_len <= account_value_offsets[account_steps - 1] + account_value_lens[account_steps - 1]);
    assert(account_storage_root_offset + account_storage_root_len <= account_value_offsets[account_steps - 1] + account_value_lens[account_steps - 1]);
    let storage_root = extract_storage_root(account_leaf, account_storage_root_offset, account_storage_root_len);

    let _ = verify_mpt_with_hints(
        storage_nodes,
        storage_lens,
        storage_node_types,
        storage_path_offsets,
        storage_path_lens,
        storage_value_offsets,
        storage_value_lens,
        storage_branch_indices,
        storage_steps,
        storage_root,
        storage_key,
    );
    let storage_leaf = storage_nodes[storage_steps - 1];
    assert(storage_value_offset == storage_value_offsets[storage_steps - 1]);
    assert(storage_value_len == storage_value_lens[storage_steps - 1]);

    let mut word = [0; 32];

    if storage_value_len != 0 {
        assert(storage_value_len <= 32);

        let start = 32 - storage_value_len;

        for i in 0..32 {
            if i >= start {
                word[i] = storage_leaf[storage_value_offset + i - start];
            }
        }
    }

    let computed = compute_solvent(word);

    assert(is_solvent == computed);
    assert(credit_score == repayment_rate / 10_000);
}