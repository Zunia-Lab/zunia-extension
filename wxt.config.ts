import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import tailwindcss from "@tailwindcss/vite";
import { CONNECT_CONFIG } from "./config/connect";
import {
  HOST_PERMISSIONS,
  OPTIONAL_HOST_PERMISSIONS,
  REALTIME_HOST_PERMISSIONS,
  PROVIDER_RESOURCE_MATCHES,
} from "./config/hosts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
/** Linked workspace packages live outside this repo; Vite must be allowed to read them in dev. */
const uiPackagesDir = path.resolve(rootDir, "../zunia-ui/packages");
const localRequire = createRequire(import.meta.url);

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  /**
   * MV3 everywhere. WXT would otherwise build Firefox and Safari as MV2, which
   * drops optional_host_permissions and diverges from the Chromium build.
   */
  manifestVersion: 3,
  hooks: {
    /**
     * The signing kernel's binary, copied out of @zunialab/core on every build
     * so it is never committed stale. lib/kernel.ts fetches it by this path.
     */
    "build:publicAssets": (_wxt, files) => {
      files.push({
        absoluteSrc: localRequire.resolve("@zunialab/core/wasm"),
        relativeDest: "zunia_core_bg.wasm",
      });
    },
    /**
     * Dev mode copies each content-script match into `host_permissions` so the
     * scripting API can register the script. The https wildcard is then required
     * and optional at once, and Chrome drops the optional copy with a warning.
     * Production leaves the match on the content script, so the optional grant
     * stays.
     */
    "build:manifestGenerated": (_wxt, manifest) => {
      const generated = manifest as {
        host_permissions?: string[];
        optional_host_permissions?: string[];
      };
      const required = new Set(generated.host_permissions ?? []);
      if (!generated.optional_host_permissions?.length) return;
      const optional = generated.optional_host_permissions.filter(
        (origin) => !required.has(origin),
      );
      if (optional.length === 0) delete generated.optional_host_permissions;
      else generated.optional_host_permissions = optional;
    },
  },
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
        // The kernel glue's fallback `new URL('zunia_core_bg.wasm',
        // import.meta.url)` makes Vite emit the 600 KB binary again as a hashed
        // asset, and inline it as base64 into the worker, which is built in
        // library mode. lib/kernel.ts always passes the URL of the copy the
        // build:publicAssets hook makes, so the fallback is dead code here.
        // scripts/check-build.mjs fails the build if a second copy reappears.
        name: "zunia-kernel-wasm-single-copy",
        enforce: "pre",
        transform(code, id) {
          if (!id.replace(/\\/g, "/").endsWith("/zunia_core.js")) return null;
          const fallback = "new URL('zunia_core_bg.wasm', import.meta.url)";
          if (!code.includes(fallback)) return null;
          return code.replace(
            fallback,
            '(() => { throw new Error("@zunialab/core: pass module_or_path, the extension loads the kernel from a fixed URL"); })()',
          );
        },
      },
      {
        // Chrome Local Network Access (142+) blocks chrome-extension:// pages
        // from loading Vite HMR modules on localhost unless the preflight gets
        // Access-Control-Allow-Private-Network. Without this, onboarding/popup
        // render as a blank white page in unpackaged dev.
        name: "zunia-dev-local-network-access",
        configureServer(server) {
          const middleware = (
            req: IncomingMessage,
            res: ServerResponse,
            next: () => void,
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
        // Bundle UI from source so validator logos and other wallet widgets
        // pick up package edits without a stale dist.
        "@zunialab/ui/styles.css": path.resolve(
          uiPackagesDir,
          "ui/dist/styles.css",
        ),
        "@zunialab/ui/validator-logos": path.resolve(
          uiPackagesDir,
          "ui/src/wallet/validatorLogoResolve.ts",
        ),
        "@zunialab/ui": path.resolve(uiPackagesDir, "ui/src/index.ts"),
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
  manifest: ({ browser }) => ({
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
    /**
     * Safari has neither the idle nor the notifications API for extensions:
     * auto-lock there runs on its timer alone, and browser alerts are off.
     */
    permissions:
      browser === "safari" ? ["storage", "alarms"] : ["storage", "alarms", "idle"],
    /** Asked for when the user turns on browser alerts, never at install. */
    ...(browser === "safari" ? {} : { optional_permissions: ["notifications"] }),
    /**
     * Narrow host_permissions: extension-owned API hosts only.
     * dApp RPC / CosmJS traffic runs in the page context (or via
     * externally_connectable / user-granted origins), not via broad https host wildcards.
     */
    host_permissions: [...HOST_PERMISSIONS],
    optional_host_permissions: [
      ...OPTIONAL_HOST_PERMISSIONS,
      ...REALTIME_HOST_PERMISSIONS,
    ],
    /**
     * Chromium only. Firefox has no externally_connectable, and Safari's
     * support differs, so first-party pages talk to the wallet through
     * window.zunia there like every other site.
     */
    ...(browser === "firefox" || browser === "safari"
      ? {}
      : {
          externally_connectable: {
            matches: [...CONNECT_CONFIG.externallyConnectableMatches],
          },
        }),
    web_accessible_resources: [
      {
        resources: ["injected.js", "content-scripts/injected.js"],
        matches: [...PROVIDER_RESOURCE_MATCHES],
      },
      {
        // The in-page connect prompt. Only this page is frameable by sites;
        // the popup, onboarding and everything that signs are not web
        // accessible, so no page can embed them.
        resources: ["connect.html"],
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
       * The same `https:` source also shows the favicon of a site the user
       * connected, on the Connected dApps screen. It is fetched from that
       * site's own origin, which already knows the user visits it, and never
       * from a third-party icon service that would learn the list.
       *
       * `script-src 'self'` is what actually keeps foreign code out, and it is
       * unchanged. An `<img>` cannot execute script, and every NFT image is
       * rendered with `referrerPolicy="no-referrer"` so the request carries
       * nothing about this extension.
       *
       * `'wasm-unsafe-eval'` lets the worker compile the signing kernel, which
       * is bundled with the extension. It permits WebAssembly compilation and
       * nothing else: `eval` and `new Function` stay blocked.
       *
       * `frame-ancestors` admits the pages the connect prompt is drawn on and
       * nothing else. It applies to every extension page, but only
       * connect.html is web accessible, so it is the only page a site can
       * actually load in a frame.
       */
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; frame-ancestors 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' data: https:;",
    },
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "extension@zunialab.com",
              /**
               * Firefox's built-in data consent starts at 140 (an ESR). Below it
               * an extension that transmits data must draw its own consent screen.
               */
              strict_min_version: "140.0",
              /**
               * Addresses go to the chain endpoints balances are read from, and
               * signed transactions to the node that broadcasts them. Nothing is
               * sent to a Zunia server.
               */
              data_collection_permissions: {
                required: ["financialAndPaymentInfo"],
              },
            },
            /** The same consent prompt reached Firefox for Android in 142. */
            gecko_android: { strict_min_version: "142.0" },
          },
        }
      : {}),
  }),
});
