import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";

export interface TelemetryContext {
	traceId: string;
	spanId?: string;
	userAddress?: string;
}

const asyncLocalStorage = new AsyncLocalStorage<TelemetryContext>();

export const baseLogger = pino({
	level: process.env.LOG_LEVEL || "info",
	base: {
		service: "zk-credit-backend",
		env: process.env.NODE_ENV || "development",
	},
	timestamp: pino.stdTimeFunctions.isoTime,
});

export const logger = new Proxy(baseLogger, {
	get(target, prop, receiver) {
		const store = asyncLocalStorage.getStore();
		if (store && (prop === "info" || prop === "error" || prop === "warn" || prop === "debug")) {
			const origFn = Reflect.get(target, prop, receiver);
			return (...args: any[]) => {
				if (typeof args[0] === "object" && args[0] !== null) {
					args[0] = { ...store, ...args[0] };
				} else {
					args.unshift(store);
				}
				return origFn.apply(target, args);
			};
		}
		return Reflect.get(target, prop, receiver);
	},
});

export function runWithContext<T>(context: TelemetryContext, fn: () => T): T {
	return asyncLocalStorage.run(context, fn);
}

export function getTraceContext(): TelemetryContext | undefined {
	return asyncLocalStorage.getStore();
}
