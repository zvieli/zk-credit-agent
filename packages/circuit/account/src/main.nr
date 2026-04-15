use common::{decode_rlp, list_item, read_bytes32, verify_mpt};

fn extract_storage_root(node: [u8; 600]) -> [u8; 32] {
    let (_, fields_offset, _, _) = decode_rlp(node, 0, 600);
    let (_, leaf_value_offset, _) = list_item(node, fields_offset, 1);
    let (_, record_payload_offset, _, _) = decode_rlp(node, leaf_value_offset, 600);
    let (_, soff, slen) = list_item(node, record_payload_offset, 2);

    assert(slen == 32);

    read_bytes32(node, soff, 600)
}

fn main(
    state_root: pub [u8; 32],
    storage_root: pub [u8; 32],
    key: [u8; 64], // Nibbles
    nodes: [[u8; 600]; 9], 
    lens: [u32; 9],        
    steps: u32
) {
    let _ = verify_mpt(nodes, lens, steps, state_root, key);
    let node = nodes[steps - 1];
    let root = extract_storage_root(node);

    for i in 0..32 {
        assert(root[i] == storage_root[i]);
    }
}
