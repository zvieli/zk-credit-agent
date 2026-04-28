use ::keccak256::keccak256;

fn assert_in_bounds(start: u32, len: u32, max: u32) {
    assert(start + len <= max);
}

fn rlp_header_len(prefix: u8) -> u32 {
    if prefix < 0x80 {
        1
    } else if prefix <= 0xb7 {
        1
    } else if prefix < 0xc0 {
        1 + ((prefix - 0xb7) as u32)
    } else if prefix <= 0xf7 {
        1
    } else {
        1 + ((prefix - 0xf7) as u32)
    }
}

fn decode_rlp_length(data: [u8; 600], length_offset: u32, length_size: u32) -> u32 {
    assert(length_size > 0);
    assert(length_size <= 4);
    assert_in_bounds(length_offset, length_size, 600);
    assert(data[length_offset] != 0);

    let mut len: u32 = 0;
    for i in 0..4 {
        if i < length_size {
            len = len * 256 + data[length_offset + i] as u32;
        }
    }

    assert(len >= 56);
    len
}

pub fn decode_rlp_with_hint(data: [u8; 600], hint_offset: u32, hint_len: u32) -> [u8; 32] {
    assert(hint_offset > 0);
    assert(hint_offset <= 600);
    assert(hint_len <= 600);

    if hint_len == 1 {
        let prefix = data[hint_offset - 1];

        if prefix == 0x81 {
            assert(hint_len == 1);
        } else {
            assert(data[hint_offset] < 0x80);
        }
    } else if hint_len < 56 {
        let prefix = data[hint_offset - 1];

        if prefix < 0x80 {
            assert(false);
        } else if prefix <= 0xb7 {
            assert((prefix - 0x80) as u32 == hint_len);
            assert_in_bounds(hint_offset, hint_len, 600);
        } else if prefix < 0xc0 {
            assert(false);
        } else if prefix <= 0xf7 {
            assert((prefix - 0xc0) as u32 == hint_len);
            assert_in_bounds(hint_offset, hint_len, 600);
        } else {
            assert(false);
        }
    } else {
        let mut matched = false;

        for length_size in 1..5 {
            if !matched {
                if hint_offset > length_size {
                    let candidate_prefix = data[hint_offset - length_size - 1];

                    if candidate_prefix >= 0xb8 {
                        if candidate_prefix <= 0xbf {
                            let encoded_len = decode_rlp_length(data, hint_offset - length_size, length_size);
                            if encoded_len == hint_len {
                                matched = true;
                            }
                        } else {
                            if candidate_prefix >= 0xf8 {
                                if candidate_prefix <= 0xff {
                                    let encoded_len = decode_rlp_length(data, hint_offset - length_size, length_size);
                                    if encoded_len == hint_len {
                                        matched = true;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        assert(matched);
    }

    let mut out = [0; 32];
    for i in 0..32 {
        if i < hint_len {
            out[i] = data[hint_offset + i];
        }
    }

    out
}

pub fn read_bytes32(node: [u8; 600], start: u32, node_len: u32) -> [u8; 32] {
    assert_in_bounds(start, 32, node_len);

    let mut out = [0; 32];
    for i in 0..32 {
        out[i] = node[start + i];
    }
    out
}

pub fn decode_rlp(data: [u8; 600], offset: u32, max_len: u32) -> (u8, u32, u32, u32) {
    assert(offset < max_len);

    let prefix = data[offset];
    let header_len = rlp_header_len(prefix);

    if prefix < 0x80 {
        (0, offset, 1, 1)
    } else if prefix <= 0xb7 {
        let len: u32 = (prefix - 0x80) as u32;
        assert_in_bounds(offset + 1, len, max_len);
        (0, offset + 1, len, len + header_len)
    } else if prefix < 0xc0 {
        assert(prefix <= 0xbf);
        let lsize: u32 = (prefix - 0xb7) as u32;
        assert(lsize > 0);
        assert(lsize <= 4);
        assert_in_bounds(offset + 1, lsize, max_len);
        assert(data[offset + 1] != 0);

        let mut len: u32 = 0;
        for i in 0..4 {
            if i < lsize {
                len = len * 256 + data[offset + 1 + i] as u32;
            }
        }

        assert(len >= 56);
        assert_in_bounds(offset + 1 + lsize, len, max_len);
        (0, offset + header_len, len, len + header_len)
    } else if prefix <= 0xf7 {
        let len: u32 = (prefix - 0xc0) as u32;
        assert_in_bounds(offset + 1, len, max_len);
        (1, offset + 1, len, len + header_len)
    } else if prefix >= 0xf8 {
        let lsize: u32 = (prefix - 0xf7) as u32;
        assert(lsize > 0);
        assert(lsize <= 4);
        assert_in_bounds(offset + 1, lsize, max_len);
        assert(data[offset + 1] != 0);

        let mut len: u32 = 0;
        for i in 0..4 {
            if i < lsize {
                len = len * 256 + data[offset + 1 + i] as u32;
            }
        }

        assert(len >= 56);
        assert_in_bounds(offset + 1 + lsize, len, max_len);
        (1, offset + header_len, len, len + header_len)
    } else {
        assert(false);
        (0, offset, 0, 0)
    }
}

pub fn list_count(data: [u8; 600], off: u32, len: u32) -> u32 {
    let mut cur: u32 = off;
    let end: u32 = off + len;
    let mut count: u32 = 0;

    for _i in 0..18 {
        if cur < end {
            let (_, _, _, tlen) = decode_rlp(data, cur, 600);
            assert(tlen > 0);
            cur += tlen;
            count += 1;
        }
    }

    assert(cur == end);
    if count != 2 {
        assert(count == 17);
    }
    count
}

pub fn list_item(data: [u8; 600], off: u32, idx: u32) -> (u32, u32, u32) {
    let mut cur: u32 = off;
    let mut found = false;
    let mut found_off: u32 = 0;
    let mut found_payload_off: u32 = 0;
    let mut found_payload_len: u32 = 0;

    for i in 0..18 {
        if !found {
            let (_, poff, plen, tlen) = decode_rlp(data, cur, 600);

            if i == idx {
                found = true;
                found_off = cur;
                found_payload_off = poff;
                found_payload_len = plen;
            }

            cur += tlen;
        }
    }

    assert(found);
    (found_off, found_payload_off, found_payload_len)
}

pub fn list_first_two(data: [u8; 600], off: u32, _len: u32) -> (u32, u32, u32, u32, u32, u32, u32) {
    let (_, first_payload_off, first_payload_len, first_total_len) = decode_rlp(data, off, 600);
    let second_off = off + first_total_len;
    let (_, second_payload_off, second_payload_len, second_total_len) = decode_rlp(data, second_off, 600);

    assert(first_total_len > 0);
    assert(second_total_len > 0);

    (off, first_payload_off, first_payload_len, second_off, second_payload_off, second_payload_len, second_total_len)
}

pub fn branch_get_item(data: [u8; 600], off: u32, idx: u32) -> (u32, u32) {
    let mut cur: u32 = off;
    let mut found = false;
    let mut found_payload_off: u32 = 0;
    let mut found_payload_len: u32 = 0;

    for i in 0..17 {
        let (_, poff, plen, tlen) = decode_rlp(data, cur, 600);

        if i as u32 == idx {
            found = true;
            found_payload_off = poff;
            found_payload_len = plen;
        }

        cur += tlen;
    }

    assert(found);
    (found_payload_off, found_payload_len)
}

pub fn verify_inline(parent: [u8; 600], child: [u8; 600], len: u32, off: u32) {
    assert(len <= 32);

    for i in 0..32 {
        if i < len {
            assert(child[i] == parent[off + i]);
        }
    }
}

pub fn verify_path(node: [u8; 600], off: u32, len: u32, key_nibbles: [u8; 64], key_off: u32) -> (bool, u32) {
    assert(len > 0);
    assert(len <= 33);

    let first = node[off];
    let prefix = first >> 4;

    let is_leaf = prefix >= 2;
    let odd = prefix % 2 == 1;

    let mut consumed: u32 = 0;
    let total = if odd { len * 2 - 1 } else { len * 2 - 2 };

    if odd {
        assert((first & 0x0f) == key_nibbles[key_off]);
        consumed = 1;
    } else {
        assert((first & 0x0f) == 0);
    }

    for i in 1..33 {
        if i < len {
            let b = node[off + i];
            let hi = b >> 4;
            let lo = b & 0x0f;

            if consumed < total {
                assert(hi == key_nibbles[key_off + consumed]);
                consumed += 1;
            }
            if consumed < total {
                assert(lo == key_nibbles[key_off + consumed]);
                consumed += 1;
            }
        }
    }

    assert(consumed == total);
    assert(key_off + total <= 64);

    (is_leaf, total)
}

pub fn verify_mpt(
    nodes: [[u8; 600]; 9],
    lens: [u32; 9],
    steps: u32,
    root: [u8; 32],
    key_nibbles: [u8; 64]
) -> (u32, u32) {
    assert(steps > 0);
    assert(steps <= 9);

    let mut cur_root = root;
    let mut cur_hash = keccak256(nodes[0], lens[0]);
    let mut key_off: u32 = 0;

    let mut term_off: u32 = 0;
    let mut term_len: u32 = 0;

    for i in 0..9 {
        if i < steps {
            let node = nodes[i];
            let len = lens[i];

            assert(len > 0);
            assert(len <= 600);

            let (kind, off, plen, tlen) = decode_rlp(node, 0, len);
            assert(kind == 1);
            assert(tlen == len);

            let (_, path_off, path_len, val_off, val_payload_off, val_len, val_total_len) = list_first_two(node, off, plen);
            let is_compact = val_off + val_total_len == off + plen;
            assert(val_off + val_total_len <= off + plen);

            assert(cur_hash == cur_root);

            if i < steps - 1 {
                let next = nodes[i + 1];
                let next_hash = keccak256(next, lens[i + 1]);

                if is_compact {
                    let (leaf, used) = verify_path(node, path_off, path_len, key_nibbles, key_off);
                    assert(!leaf);

                    if val_len == 32 {
                        let h = read_bytes32(node, val_off, len);
                        assert(h == next_hash);
                    } else {
                        assert(val_len < 32);
                        verify_inline(node, next, val_len, val_off);
                    }

                    key_off += used;
                    cur_root = next_hash;
                    cur_hash = next_hash;
                } else {
                    let idx = key_nibbles[key_off];
                    let (boff, blen) = branch_get_item(node, off, idx as u32);

                    if blen == 32 {
                        let h = read_bytes32(node, boff, len);
                        assert(h == next_hash);
                    } else {
                        assert(blen < 32);
                        verify_inline(node, next, blen, boff);
                    }

                    key_off += 1;
                    cur_root = next_hash;
                    cur_hash = next_hash;
                }
            } else {
                if is_compact {
                    let (leaf, used) = verify_path(node, path_off, path_len, key_nibbles, key_off);
                    assert(leaf);
                    assert(key_off + used == 64);

                    term_off = val_payload_off;
                    term_len = val_len;
                } else {
                    let (boff, blen) = branch_get_item(node, off, 16);
                    assert(key_off == 64);
                    assert(blen <= 32);

                    term_off = boff;
                    term_len = blen;
                }
            }
        }
    }

    (term_off, term_len)
}

pub fn verify_mpt_with_hints(
    nodes: [[u8; 600]; 9],
    lens: [u32; 9],
    node_types: [u32; 9],
    path_offsets: [u32; 9],
    path_lens: [u32; 9],
    value_offsets: [u32; 9],
    value_lens: [u32; 9],
    branch_indices: [u32; 9],
    steps: u32,
    root: [u8; 32],
    key_nibbles: [u8; 64]
) -> (u32, u32) {
    assert(steps > 0);
    assert(steps <= 9);

    let mut cur_root = root;
    let mut cur_hash = keccak256(nodes[0], lens[0]);
    let mut key_off: u32 = 0;

    let mut term_off: u32 = 0;
    let mut term_len: u32 = 0;

    for i in 0..9 {
        if i < steps {
            let node = nodes[i];
            let len = lens[i];

            assert(len > 0);
            assert(len <= 600);

            let (kind, _, _, tlen) = decode_rlp(node, 0, len);
            assert(kind == 1);
            assert(tlen == len);
            assert(cur_hash == cur_root);

            let value_off = value_offsets[i];
            let value_len = value_lens[i];
            assert(value_off > 0);
            assert(value_off + value_len <= len);

            if node_types[i] == 1 {
                let path_off = path_offsets[i];
                let path_len = path_lens[i];

                assert(path_off > 0);
                assert(path_len > 0);
                assert(path_off + path_len <= len);

                let (leaf, used) = verify_path(node, path_off, path_len, key_nibbles, key_off);

                if i < steps - 1 {
                    assert(!leaf);
                    assert(value_len <= 32);

                    let next = nodes[i + 1];
                    let next_hash = keccak256(next, lens[i + 1]);

                    if value_len == 32 {
                        let h = read_bytes32(node, value_off, len);
                        assert(h == next_hash);
                    } else {
                        verify_inline(node, next, value_len, value_off);
                    }

                    key_off += used;
                    cur_root = next_hash;
                    cur_hash = next_hash;
                } else {
                    assert(leaf);
                    assert(key_off + used == 64);
                    let _ = decode_rlp_with_hint(node, value_off, value_len);
                    term_off = value_off;
                    term_len = value_len;
                }
            } else {
                if i < steps - 1 {
                    assert(branch_indices[i] < 16);
                    assert(key_nibbles[key_off] == branch_indices[i] as u8);
                    assert(value_len <= 32);

                    let next = nodes[i + 1];
                    let next_hash = keccak256(next, lens[i + 1]);

                    if value_len == 32 {
                        let h = read_bytes32(node, value_off, len);
                        assert(h == next_hash);
                    } else {
                        verify_inline(node, next, value_len, value_off);
                    }

                    key_off += 1;
                    cur_root = next_hash;
                    cur_hash = next_hash;
                } else {
                    assert(branch_indices[i] == 16);
                    assert(key_off == 64);
                    let _ = decode_rlp_with_hint(node, value_off, value_len);
                    term_off = value_off;
                    term_len = value_len;
                }
            }
        }
    }

    (term_off, term_len)
}

pub fn bit_at_word(word: [u8; 32], bit_index: u32) -> bool {
    let byte_index = 31 - (bit_index / 8);
    let bit_index_in_byte = (bit_index % 8) as u8;
    ((word[byte_index] >> bit_index_in_byte) & 1u8) == 1u8
}

pub fn compute_solvent(word: [u8; 32]) -> bool {
    let mut has_collateral = false;
    let mut has_debt = false;

    for i in 0..128 {
        if bit_at_word(word, i * 2 + 1) {
            has_collateral = true;
        }
        if bit_at_word(word, i * 2) {
            has_debt = true;
        }
    }

    if has_collateral {
        !has_debt
    } else {
        false
    }
}
