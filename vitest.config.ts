import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // One React, as the extension build has (wxt.config.ts): the linked UI
    // package would otherwise load its own copy, and a component with hooks
    // (a token logo) could not render in a test.
    dedupe: ["react", "react-dom"],
    alias: {
      react: path.resolve(rootDir, "node_modules/react"),
      "react-dom": path.resolve(rootDir, "node_modules/react-dom"),
    },
  },
  test: {
    environment: "node",
    // Radix (behind Button's `asChild`) lives in the UI package's own
    // node_modules; run it through Vite so it gets the one React above.
    server: { deps: { inline: [/@radix-ui\//] } },
    include: ["lib/**/*.test.ts", "lib/__tests__/**/*.ts", "entrypoints/**/*.test.ts"],
  },
});
