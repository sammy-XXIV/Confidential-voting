import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({ include: ["buffer", "process"] }),
  ],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      external: ["/relayer-sdk/relayer-sdk-js.js"],
    },
  },
});
