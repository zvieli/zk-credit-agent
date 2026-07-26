import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithContext } from "./logger.js";
import { httpRequestDurationSeconds, httpRequestsTotal } from "./metrics.js";

export function telemetryMiddleware(
	req: Request,
	res: Response,
	next: NextFunction,
) {
	const traceId =
		(req.headers["x-trace-id"] as string) || crypto.randomUUID();
	res.setHeader("x-trace-id", traceId);

	const context = {
		traceId,
		spanId: crypto.randomUUID().slice(0, 8),
		userAddress: (req.body?.userAddress as string) || undefined,
	};

	const startTime = process.hrtime();

	res.on("finish", () => {
		const diff = process.hrtime(startTime);
		const durationSeconds = diff[0] + diff[1] / 1e9;
		const route = req.route?.path || req.path || "unknown";
		const status = res.statusCode.toString();

		httpRequestsTotal.inc({ method: req.method, route, status });
		httpRequestDurationSeconds.observe(
			{ method: req.method, route, status },
			durationSeconds,
		);
	});

	runWithContext(context, () => {
		next();
	});
}
