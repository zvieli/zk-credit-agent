import { buildSendQuery, getAxiomV2QueryAddress } from '@axiom-crypto/client';
async function run() {
  try {
    const res = await buildSendQuery({
      chainId: '31337',
      rpcUrl: 'http://127.0.0.1:8545',
      axiomV2QueryAddress: getAxiomV2QueryAddress('1'),
      dataQuery: [{ type: 1, subqueryData: { blockNumber: 10000000, fieldIdx: 0 } }],
      computeQuery: { k: 0, resultLen: 1, vkey: [], computeProof: '0x00' },
      callback: { target: '0x1234567890123456789012345678901234567890', extraData: '0x' },
      caller: '0x1234567890123456789012345678901234567890',
      mock: true,
      options: {}
    } as any);
    console.log("Success! Returned chainId:", (res as any).chainId);
  } catch (e) {
    console.error(e);
  }
}
run();
