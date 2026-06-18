import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");

const copies = [
	{
		source: resolve(
			workspaceRoot,
			"packages/circuit/combined/target/combined.json",
		),
		destination: resolve(packageRoot, "public/combined_circuit.json"),
	},
];

for (const copy of copies) {
	if (!existsSync(copy.source)) {
		throw new Error(`Missing circuit artifact: ${copy.source}`);
	}

	mkdirSync(dirname(copy.destination), { recursive: true });
	writeFileSync(copy.destination, readFileSync(copy.source));
}

console.log("Synced circuit JSON assets into packages/frontend/public");
