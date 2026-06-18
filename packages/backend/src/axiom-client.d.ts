declare module "@axiom-crypto/client" {
	export const buildSendQuery: (...args: any[]) => Promise<any>;
	export const getAxiomV2QueryAddress: (chainId: string) => string;
}
