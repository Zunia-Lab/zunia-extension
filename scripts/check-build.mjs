#!/usr/bin/env node
/**
 * Checks the production builds in .output before they are zipped or loaded: Manifest V3
 * everywhere, the kernel binary shipped once at the fixed path lib/kernel.ts loads, no
 * inlined or bare-imported kernel, an unchanged permission set, and the manifest keys
 * each browser expects. It also checks that the linked @zunialab/interchain dist is
 * newer than its source, and that each build bundles that dist rather than an older one.
 *
 * Usage: node scripts/check-build.mjs [chrome] [edge] [firefox] [safari]
 * Without arguments, every production build found in .output is checked.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, ".output");
const BROWSERS = ["chrome", "edge", "firefox", "safari"];

// Every entry shows up in the install prompt. Growing this list is a product decision.
const ALLOWED_PERMISSIONS = new Set(["storage", "alarms", "idle"]);
// The rest of the permission surface, as 0.1.2 shipped it. Each entry shows up in an
// install or runtime prompt, so growing these lists is a product decision too.
// Asked for when the user turns on browser alerts, never at install.
const ALLOWED_OPTIONAL_PERMISSIONS = new Set(["notifications"]);
// config/hosts.ts: Zunia's own API hosts and a local node.
const ALLOWED_HOST_PERMISSIONS = new Set([
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
  "https://backend.zunialab.com/*",
  "https://api.zunialab.com/*",
  "https://indexer.zunialab.com/*",
]);
// Chain endpoints, asked for when the user turns on live balances or realtime updates.
const ALLOWED_OPTIONAL_HOST_PERMISSIONS = new Set(["https://*/*", "wss://*/*", "ws://*/*"]);
// Pages the provider is injected into. Firefox grants these at install.
const ALLOWED_CONTENT_SCRIPT_MATCHES = new Set([
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
]);
// What Firefox's data consent prompt lists.
const ALLOWED_DATA_COLLECTION = new Set(["financialAndPaymentInfo"]);
// zunia-sdk refused a swap from funds held on Osmosis with this sentence until commit
// 8c4e0f9. 0.1.2 shipped it from a dist built before that commit, so a bundle that
// still has it was built from a stale dist.
const STALE_SDK_TEXT = "takes two transactions and is not planned as one route";
// The extension bundles @zunialab/interchain from this link. Until the package is on
// npm, pnpm.overrides points it at the zunia-sdk checkout next to this repo.
const INTERCHAIN_LINK = path.join(rootDir, "node_modules", "@zunialab", "interchain");
const SIBLING_INTERCHAIN = path.resolve(rootDir, "..", "zunia-sdk", "packages", "interchain");
const KERNEL_FILE = "zunia_core_bg.wasm";
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const REQUIRED_FILES = ["background.js", "injected.js", "popup.html", "connect.html", "onboarding.html"];
const WEB_ACCESSIBLE = ["injected.js", "connect.html"];
const GECKO_ID = "wallet@zunialab.com";
// Firefox shows its own data consent prompt from 140; older versions would need ours.
const MIN_FIREFOX = 140;

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const relative = (file) => path.relative(rootDir, file).split(path.sep).join("/");

/**
 * The extension bundles @zunialab/interchain from its dist, which zunia-sdk does not
 * commit. A dist older than any file in its src ships code the source no longer has.
 * Only a checkout has a src folder; a package installed from npm has none to compare.
 *
 * Returns the problems, the dist's build time (which no build may predate) and the src
 * folder it was compared with (`null` when there is none).
 */
function checkInterchainDist() {
  let dir = null;
  try {
    dir = fs.realpathSync(INTERCHAIN_LINK);
  } catch {
    if (fs.existsSync(SIBLING_INTERCHAIN)) dir = SIBLING_INTERCHAIN;
  }
  if (!dir) {
    return { problems: ["@zunialab/interchain is not installed, run pnpm install"], builtAt: null, srcDir: null };
  }
  const distFile = path.join(dir, "dist", "index.js");
  if (!fs.existsSync(distFile)) {
    return {
      problems: [`${relative(distFile)} is missing, run pnpm --filter @zunialab/interchain build in zunia-sdk`],
      builtAt: null,
      srcDir: null,
    };
  }
  const builtAt = fs.statSync(distFile).mtimeMs;
  const srcDir = path.join(dir, "src");
  if (!fs.existsSync(srcDir)) return { problems: [], builtAt, srcDir: null };
  const newer = walk(srcDir)
    .map((file) => ({ file, mtime: fs.statSync(path.join(srcDir, file)).mtimeMs }))
    .filter((entry) => entry.mtime > builtAt)
    .sort((a, b) => b.mtime - a.mtime);
  if (newer.length === 0) return { problems: [], builtAt, srcDir };
  const listed = newer.slice(0, 5).map((entry) => entry.file);
  const more = newer.length > listed.length ? ` and ${newer.length - listed.length} more` : "";
  return {
    problems: [
      `${relative(distFile)} is older than ${newer.length} file(s) in ${relative(srcDir)}: ` +
        `${listed.join(", ")}${more}. Run pnpm --filter @zunialab/interchain build in zunia-sdk, ` +
        "then rebuild the extension.",
    ],
    builtAt,
    srcDir,
  };
}

function checkBuild(browser, interchainBuiltAt) {
  const dir = path.join(outputDir, `${browser}-mv3`);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return [`${path.relative(rootDir, manifestPath)} not found, run pnpm build:${browser}`];
  }
  const problems = [];
  const fail = (message) => problems.push(message);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = walk(dir);

  // WXT writes manifest.json last, so its time is the build's.
  if (interchainBuiltAt !== null && fs.statSync(manifestPath).mtimeMs < interchainBuiltAt) {
    fail(`built before the @zunialab/interchain dist it should bundle, run pnpm build:${browser} again`);
  }

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version is ${manifest.manifest_version}, expected 3`);
  }

  const csp = manifest.content_security_policy?.extension_pages ?? "";
  const scriptSrc =
    csp
      .split(";")
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith("script-src")) ?? "";
  if (!scriptSrc.includes("'wasm-unsafe-eval'")) {
    fail("script-src lacks 'wasm-unsafe-eval', so the kernel cannot compile");
  }
  if (/(^|\s)'unsafe-(eval|inline)'/.test(scriptSrc)) {
    fail(`script-src allows eval or inline scripts: ${scriptSrc}`);
  }

  const wasmFiles = files.filter((file) => file.endsWith(".wasm"));
  if (wasmFiles.length !== 1 || wasmFiles[0] !== KERNEL_FILE) {
    fail(`expected one ${KERNEL_FILE} at the root, found: ${wasmFiles.join(", ") || "none"}`);
  } else if (!fs.readFileSync(path.join(dir, KERNEL_FILE)).subarray(0, 4).equals(WASM_MAGIC)) {
    fail(`${KERNEL_FILE} is not a WebAssembly binary`);
  }

  for (const file of files) {
    if (!/\.(js|mjs|html|json)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    if (text.includes("data:application/wasm") || text.includes("AGFzbQE")) {
      fail(`${file} inlines a WebAssembly binary`);
    }
    if (/(?:\bfrom\s*|\bimport\(\s*)["']@zunialab\/core["']/.test(text)) {
      fail(`${file} keeps a bare "@zunialab/core" import that no browser can resolve`);
    }
    if (text.includes("zuniawallet")) {
      fail(`${file} still names the retired zuniawallet domain`);
    }
    if (file.endsWith(".html") && /<script(?![^>]*\bsrc=)[^>]*>/i.test(text)) {
      fail(`${file} has an inline script, which script-src 'self' blocks`);
    }
    if (text.includes(STALE_SDK_TEXT)) {
      fail(
        `${file} still says "${STALE_SDK_TEXT}": it bundles a @zunialab/interchain dist ` +
          "built before zunia-sdk 8c4e0f9. Rebuild the SDK dist, then this build.",
      );
    }
  }

  for (const file of REQUIRED_FILES) {
    if (!files.includes(file)) fail(`${file} is missing`);
  }
  const accessible = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []);
  for (const resource of WEB_ACCESSIBLE) {
    if (!accessible.includes(resource)) fail(`web_accessible_resources lacks ${resource}`);
  }

  const background = manifest.background ?? {};
  if (browser === "firefox") {
    if (!Array.isArray(background.scripts) || background.service_worker) {
      fail("Firefox needs background.scripts (an event page), not a service worker");
    }
  } else if (typeof background.service_worker !== "string") {
    fail("background.service_worker is missing");
  }

  for (const permission of manifest.permissions ?? []) {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      fail(`unexpected permission "${permission}"; if intended, add it to ALLOWED_PERMISSIONS`);
    }
  }
  const surface = [
    ["optional_permissions", manifest.optional_permissions, ALLOWED_OPTIONAL_PERMISSIONS, "ALLOWED_OPTIONAL_PERMISSIONS"],
    ["host_permissions", manifest.host_permissions, ALLOWED_HOST_PERMISSIONS, "ALLOWED_HOST_PERMISSIONS"],
    [
      "optional_host_permissions",
      manifest.optional_host_permissions,
      ALLOWED_OPTIONAL_HOST_PERMISSIONS,
      "ALLOWED_OPTIONAL_HOST_PERMISSIONS",
    ],
    [
      "content_scripts matches",
      (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []),
      ALLOWED_CONTENT_SCRIPT_MATCHES,
      "ALLOWED_CONTENT_SCRIPT_MATCHES",
    ],
  ];
  for (const [key, entries, allowed, listName] of surface) {
    for (const entry of entries ?? []) {
      if (!allowed.has(entry)) fail(`unexpected ${key} entry "${entry}"; if intended, add it to ${listName}`);
    }
  }

  const gecko = manifest.browser_specific_settings?.gecko;
  if (browser === "firefox") {
    if (gecko?.id !== GECKO_ID) fail(`gecko.id is ${gecko?.id}, expected ${GECKO_ID}`);
    if (!(Number.parseFloat(gecko?.strict_min_version ?? "0") >= MIN_FIREFOX)) {
      fail(`gecko.strict_min_version is ${gecko?.strict_min_version}, expected ${MIN_FIREFOX}.0 or later`);
    }
    if (!gecko?.data_collection_permissions) {
      fail("gecko.data_collection_permissions is missing, AMO rejects new add-ons without it");
    }
    for (const kind of ["required", "optional"]) {
      for (const entry of gecko?.data_collection_permissions?.[kind] ?? []) {
        if (!ALLOWED_DATA_COLLECTION.has(entry)) {
          fail(`unexpected data_collection_permissions.${kind} entry "${entry}"; if intended, add it to ALLOWED_DATA_COLLECTION`);
        }
      }
    }
  } else if (gecko) {
    fail("browser_specific_settings belongs in the Firefox build only");
  }

  const external = manifest.externally_connectable;
  if (browser === "firefox" || browser === "safari") {
    if (external) fail(`externally_connectable is not supported in ${browser}`);
  } else {
    const matches = external?.matches ?? [];
    if (matches.length === 0) fail("externally_connectable.matches is missing");
    for (const match of matches) {
      if (!/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)\/)/.test(match)) {
        fail(`externally_connectable allows a non-HTTPS origin: ${match}`);
      }
    }
  }

  if (files.some((file) => file.endsWith(".map"))) {
    fail("source maps are shipped in a production build");
  }

  // Content-script CSS is inserted into the host page. A font or body rule
  // there replaces the site's own typography.
  for (const script of manifest.content_scripts ?? []) {
    for (const cssFile of script.css ?? []) {
      const cssPath = path.join(dir, cssFile);
      if (!fs.existsSync(cssPath)) {
        fail(`content script css ${cssFile} is missing`);
        continue;
      }
      const css = fs.readFileSync(cssPath, "utf8");
      if (/@font-face|font-family|\bbody\b|\bhtml\b|:root/.test(css)) {
        fail(
          `${cssFile} styles the host page. Content-script CSS must not set fonts or document margins.`,
        );
      }
    }
  }
  return problems;
}

const requested = process.argv.slice(2);
for (const browser of requested) {
  if (!BROWSERS.includes(browser)) {
    console.error(`Unknown browser "${browser}", expected one of ${BROWSERS.join(", ")}.`);
    process.exit(2);
  }
}
const targets =
  requested.length > 0
    ? requested
    : BROWSERS.filter((browser) => fs.existsSync(path.join(outputDir, `${browser}-mv3`, "manifest.json")));
if (targets.length === 0) {
  console.error("No production build in .output. Run pnpm build first.");
  process.exit(1);
}

let failed = false;
const interchain = checkInterchainDist();
if (interchain.problems.length === 0) {
  const against = interchain.srcDir ? `newer than every file in ${relative(interchain.srcDir)}` : "no src to compare";
  console.log(`ok   @zunialab/interchain dist, ${against}`);
} else {
  failed = true;
  console.error("FAIL @zunialab/interchain dist");
  for (const problem of interchain.problems) console.error(`  - ${problem}`);
}
for (const browser of targets) {
  const problems = checkBuild(browser, interchain.builtAt);
  if (problems.length === 0) {
    console.log(`ok   ${browser}-mv3`);
    continue;
  }
  failed = true;
  console.error(`FAIL ${browser}-mv3`);
  for (const problem of problems) console.error(`  - ${problem}`);
}
process.exit(failed ? 1 : 0);
