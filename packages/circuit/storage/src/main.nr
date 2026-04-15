use common::{bit_at_word, decode_rlp, verify_mpt};

fn compute_solvent(word: [u8; 32]) -> bool {
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

fn main(
    repayment_rate: u32,
    nodes: [[u8; 600]; 9],
    lens: [u32; 9],
    steps: u32,
    storage_root: pub [u8; 32],
    key: pub [u8; 64],
    is_solvent: pub bool,
    credit_score: pub u32
) {
    let (off,_len)=verify_mpt(nodes,lens,steps,storage_root,key);
    let node = nodes[steps-1];
    let (_, value_off, value_len, _) = decode_rlp(node, off, 600);

    let mut word=[0;32];

    if value_len!=0 {
        assert(value_len<=32);

        let start = 32-value_len;

        for i in 0..32 {
            if i>=start {
                word[i]=node[value_off + i - start];
            }
        }
    }

    let computed = compute_solvent(word);

    assert(is_solvent == computed);
    assert(credit_score == repayment_rate / 10_000);
}

mod tests {
    use super::compute_solvent;

    #[test(should_fail)]
    fn test_rejects_debt_only_word() {
        let mut word = [0; 32];
        word[31] = 1;

        assert(compute_solvent(word));
    }
}
