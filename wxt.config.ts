import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { CONNECT_CONFIG } from "./config/connect";
import {
  HOST_PERMISSIONS,
  OPTIONAL_HOST_PERMISSIONS,
  PROVIDER_RESOURCE_MATCHES,
} from "./config/hosts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
/** Linked workspace packages live outside this repo; Vite must be allowed to read them in dev. */
const uiPackagesDir = path.resolve(rootDir, "../zunia-ui/packages");

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  /**
   * Keep a dedicated Chromium profile across `pnpm dev:*` runs. Without this,
   * web-ext creates a temp profile every launch and the sealed vault in
   * chrome.storage.local disappears. Hot reload while the process is running
   * already preserves storage; this only fixes stop/start.
   *
   * Mac/Linux: --user-data-dir. Create `.wxt/chrome-data` before the first run.
   * Windows: prefer chromiumProfile + keepProfileChanges in web-ext.config.ts.
   */
  webExt: {
    // Keep the HMR server alive without web-ext owning Chrome. Closing the
    // managed Chrome window exits `pnpm dev`; load
    // `.output/chrome-mv3-dev` via chrome://extensions instead.
    disabled: true,
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  vite: () => ({
    plugins: [
      tailwindcss(),
      {
        // Chrome Local Network Access (142+) blocks chrome-extension:// pages
        // from loading Vite HMR modules on localhost unless the preflight gets
        // Access-Control-Allow-Private-Network. Without this, onboarding/popup
        // render as a blank white page in unpackaged dev.
        name: "zunia-dev-local-network-access",
        configureServer(server) {
          const middleware: import("connect").NextHandleFunction = (
            req,
            res,
            next,
          ) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader(
              "Access-Control-Allow-Methods",
              "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
            );
            res.setHeader("Access-Control-Allow-Headers", "*");
            res.setHeader("Access-Control-Allow-Private-Network", "true");
            if (req.method === "OPTIONS") {
              res.statusCode = 204;
              res.end();
              return;
            }
            next();
          };
          // Must run before Vite's CORS middleware, which otherwise answers
          // OPTIONS without the private-network header.
          server.middlewares.stack.unshift({
            route: "",
            handle: middleware,
          });
        },
      },
    ],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        react: path.resolve(rootDir, "node_modules/react"),
        "react-dom": path.resolve(rootDir, "node_modules/react-dom"),
      },
    },
    server: {
      cors: true,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Private-Network": "true",
      },
      fs: {
        allow: [rootDir, uiPackagesDir, path.resolve(rootDir, "../zunia-ui")],
      },
    },
  }),
  manifest: {
    name: "Zunia",
    description:
      "Multi-chain Cosmos wallet. Browser extension for Chrome, Firefox, Edge, and Safari.",
    icons: {
      16: "icon/16.png",
      32: "icon/32.png",
      48: "icon/48.png",
      128: "icon/128.png",
    },
    action: {
      default_title: "Zunia",
      default_icon: {
        16: "icon/16.png",
        32: "icon/32.png",
        48: "icon/48.png",
        128: "icon/128.png",
      },
    },
    permissions: ["storage", "alarms", "idle"],
    /**
     * Narrow host_permissions: extension-owned API hosts only.
     * dApp RPC / CosmJS traffic runs in the page context (or via
     * externally_connectable / user-granted origins), not via broad https host wildcards.
     */
    host_permissions: [...HOST_PERMISSIONS],
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    externally_connectable: {
      matches: [...CONNECT_CONFIG.externallyConnectableMatches],
    },
    web_accessible_resources: [
      {
        resources: ["injected.js", "content-scripts/injected.js"],
        matches: [...PROVIDER_RESOURCE_MATCHES],
      },
    ],
    content_security_policy: {
      /**
       * `img-src` carries three sources and no more.
       *
       * - `'self'` and `data:` for bundled art and inline placeholders.
       * - `https:` for two opt-in image sources: chain icons falling back to
       *   the Zunia registry on raw.githubusercontent.com, and NFT artwork,
       *   which lives on whatever host the token's minter chose - an IPFS
       *   gateway, Arweave, or a project's own CDN. There is no allowlist that
       *   could cover that, so the control is the user's: artwork is off until
       *   they turn it on (`nftMedia`, off by default), and the switch says
       *   what turning it on discloses. Narrowing this back to a fixed host
       *   list would not make the wallet safer, it would make the "Load
       *   artwork" control a lie, because nothing would ever load.
       *
       * `script-src 'self'` is what actually keeps foreign code out, and it is
       * unchanged. An `<img>` cannot execute script, and every NFT image is
       * rendered with `referrerPolicy="no-referrer"` so the request carries
       * nothing about this extension.
       */
      extension_pages:
        "script-src 'self'; object-src 'self'; frame-ancestors 'none'; img-src 'self' data: https:;",
    },
    browser_specific_settings: {
      gecko: {
        id: "extension@zunialab.com",
        strict_min_version: "120.0",
      },
    },
  },
});
