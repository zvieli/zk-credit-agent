import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import topLevelAwait from "vite-plugin-top-level-await";
import wasm from "vite-plugin-wasm";

export default defineConfig({
	plugins: [react(), wasm(), topLevelAwait()],
	base: "./",
	build: {
		target: "esnext",
	},
	worker: {
		format: "es",
	},
	optimizeDeps: {
		exclude: [
			"@noir-lang/noir_js",
			"@noir-lang/acvm_js",
			"@noir-lang/noirc_abi",
		],
		esbuildOptions: {
			target: "esnext",
		},
	},
	assetsInclude: ["**/*.wasm", "**/*.wasm.gz"],
	server: {
		port: 5173,
		strictPort: true,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
		proxy: {
			"/api": {
				target: process.env.VITE_BACKEND_URL || "http://localhost:3001",
				changeOrigin: true,
			},
		},
	},
	preview: {
		port: 4173,
		strictPort: true,
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
	},
});
