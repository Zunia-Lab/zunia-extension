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
    chromiumArgs: ["--user-data-dir=./.wxt/chrome-data"],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: {
        react: path.resolve(rootDir, "node_modules/react"),
        "react-dom": path.resolve(rootDir, "node_modules/react-dom"),
      },
    },
    server: {
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
      /** Chain icons fall back to the Zunia registry on raw.githubusercontent.com. */
      extension_pages:
        "script-src 'self'; object-src 'self'; frame-ancestors 'none'; img-src 'self' data: https://raw.githubusercontent.com;",
    },
    browser_specific_settings: {
      gecko: {
        id: "extension@zuniawallet.com",
        strict_min_version: "120.0",
      },
    },
  },
});
