use common::{compute_solvent, decode_rlp_with_hint, verify_mpt_with_hints};

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
    account_key: [u8; 64],
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
    let state_root_as_field = Field::from_be_bytes::<32>(state_root);
    let calculated_hash = std::hash::pedersen_hash([state_root_as_field, is_solvent as Field, credit_score as Field]);
    assert(calculated_hash == public_commitment);

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
        account_key,
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