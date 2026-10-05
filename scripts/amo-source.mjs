/**
 * Source archive for addons.mozilla.org.
 *
 * The archive contains the code a person wrote, plus lockfiles. It does not
 * contain build output: no dist/, no .wasm, no wasm-bindgen glue, no
 * node_modules. Reviewers rebuild that output with the commands in the README.
 *
 * https://extensionworkshop.com/documentation/publish/source-code-submission/
 */
import { chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(extensionDir, "..");
const version = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8")).version;
const stage = path.join(tmpdir(), `zunia-amo-source-${version}`);
const zipPath = path.join(extensionDir, ".output", `zunia-extension-${version}-amo-source.zip`);

const skipDir = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  "target",
  "dist",
  ".turbo",
  ".next",
  "coverage",
  "storybook-static",
]);

/** wasm-bindgen output. The Rust sources and build-wasm.sh produce these. */
const skipFile = new Set([
  ".DS_Store",
  "zunia_core.js",
  "zunia_core.d.ts",
  "zunia_core_bg.wasm.d.ts",
]);

function copyTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (skipDir.has(name) || skipFile.has(name)) return false;
      if (name.endsWith(".wasm") || name.endsWith(".map") || name.endsWith(".zip")) return false;
      return true;
    },
  });
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || "").trim().split("\n")[0];
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyTree(extensionDir, path.join(stage, "zunia-extension"));
copyTree(path.join(workspace, "zunia-core"), path.join(stage, "zunia-core"));
copyTree(path.join(workspace, "zunia-ui"), path.join(stage, "zunia-ui"));
copyTree(path.join(workspace, "zunia-sdk"), path.join(stage, "zunia-sdk"));

const forbidden = walk(stage).filter((file) => {
  const rel = path.relative(stage, file);
  return (
    rel.endsWith(".wasm") ||
    rel.includes(`${path.sep}dist${path.sep}`) ||
    rel.includes(`${path.sep}node_modules${path.sep}`) ||
    rel.endsWith(`${path.sep}zunia_core.js`) ||
    rel.endsWith(".min.js")
  );
});
if (forbidden.length > 0) {
  console.error("source archive still contains generated files:");
  for (const file of forbidden) console.error(`  ${path.relative(stage, file)}`);
  process.exit(1);
}

const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  pnpm: toolVersion("pnpm", ["-v"]),
  rustc: toolVersion("rustc", ["--version"]),
  bindgen: toolVersion("wasm-bindgen", ["--version"]),
  wasmOpt: toolVersion("wasm-opt", ["--version"]),
};

writeFileSync(path.join(stage, "README.md"), readme(version, env));
const buildScript = path.join(stage, "build.sh");
writeFileSync(buildScript, buildSh());
chmodSync(buildScript, 0o755);

mkdirSync(path.dirname(zipPath), { recursive: true });
rmSync(zipPath, { force: true });
const packed = spawnSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: stage });
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}

const listing = spawnSync("unzip", ["-l", zipPath], { encoding: "utf8" });
const leaked = (listing.stdout || "")
  .split("\n")
  .filter((line) => /\.wasm\s|\.min\.js\s|\/dist\/|node_modules\/|zunia_core\.js\s/.test(line));
if (leaked.length > 0) {
  console.error("zip listing still contains generated files:");
  for (const line of leaked) console.error(line);
  process.exit(1);
}

const bytes = statSync(zipPath).size;
rmSync(stage, { recursive: true, force: true });
console.log(`${zipPath} (${bytes} bytes)`);

function buildSh() {
  return `#!/usr/bin/env bash
# Rebuilds the Firefox add-on from this source archive.
# Run from the directory that contains this file.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"

cd "$root/zunia-core"
./scripts/build-wasm.sh

cd "$root/zunia-ui"
pnpm install --frozen-lockfile
pnpm --filter @zunialab/tokens build
pnpm --filter @zunialab/ui build

cd "$root/zunia-sdk"
pnpm install --frozen-lockfile
pnpm --filter @zunialab/interchain build

cd "$root/zunia-extension"
pnpm install --frozen-lockfile
pnpm zip:firefox

echo "Built $root/zunia-extension/.output/zunia-extension-${version}-firefox.zip"
`;
}

function readme(version, env) {
  const wasmOpt = env.wasmOpt
    ? `wasm-opt is installed (${env.wasmOpt}). \`scripts/build-wasm.sh\` runs \`wasm-opt -Oz\` when the command exists, and the uploaded add-on was built that way. Install binaryen so \`wasm-opt\` is on PATH before building. Without it the .wasm bytes differ.`
    : `wasm-opt was not on PATH for this build, so \`scripts/build-wasm.sh\` kept the unoptimised module. Do not install wasm-opt before rebuilding, or the .wasm bytes will differ.`;

  return `# Zunia ${version} source for addons.mozilla.org

This archive is the source for \`zunia-extension-${version}-firefox.zip\`.
Upload that zip as the add-on file. Upload this archive as the source code for the same version.

The extension the user installs is minified by Vite. Vite is open source and runs on the reviewer's computer. The code is not obfuscated. No build step uses a website.

This archive does not contain that minified output. It does not contain \`dist/\`, WebAssembly binaries, or wasm-bindgen glue. Those files are produced by the commands below.

## Build environment

The uploaded add-on was built with:

- ${env.platform}. This is not the default reviewer image (Ubuntu 24.04.4 LTS, ARM64).
- Node.js ${env.node}. The default reviewer image has Node.js 24.14.0. Install ${env.node} or the bundle will not match: https://nodejs.org/dist/${env.node}/
- pnpm ${env.pnpm ?? "9.15.0"}, through Corepack. Do not install dependencies with npm.
- ${env.rustc ?? "Rust 1.93.0, pinned in zunia-core/rust-toolchain.toml"}
- ${env.bindgen ?? "wasm-bindgen 0.2.127, pinned in zunia-core/Cargo.lock"}
- ${wasmOpt}

Install the tools, then check the versions. Do not use npm to install dependencies. pnpm is installed through Corepack, which ships with Node.js.

\`\`\`
# Node.js ${env.node}
# https://nodejs.org/dist/${env.node}/
# or: nvm install ${env.node.replace(/^v/, "")}

corepack enable
corepack prepare pnpm@9.15.0 --activate

# Rust 1.93.0. Installer: https://rustup.rs
rustup toolchain install 1.93.0 --profile minimal --component rustfmt,clippy --target wasm32-unknown-unknown

# wasm-bindgen 0.2.127, the version in zunia-core/Cargo.lock
cargo install wasm-bindgen-cli --locked --version 0.2.127

# binaryen 130, which provides wasm-opt. The uploaded build used wasm-opt 130.
# https://github.com/WebAssembly/binaryen/releases/tag/version_130
# macOS: brew install binaryen

node -v          # ${env.node}
pnpm -v          # 9.15.0
rustc --version  # 1.93.0
wasm-bindgen --version
wasm-opt --version
\`\`\`

## Build

From this directory, the one that contains \`build.sh\`, \`zunia-extension\`, \`zunia-core\`, \`zunia-ui\`, and \`zunia-sdk\`:

\`\`\`
./build.sh
\`\`\`

\`build.sh\` is the build script. It runs every technical step, in order:

\`\`\`
cd zunia-core
./scripts/build-wasm.sh

cd ../zunia-ui
pnpm install --frozen-lockfile
pnpm --filter @zunialab/tokens build
pnpm --filter @zunialab/ui build

cd ../zunia-sdk
pnpm install --frozen-lockfile
pnpm --filter @zunialab/interchain build

cd ../zunia-extension
pnpm install --frozen-lockfile
pnpm zip:firefox
\`\`\`

Compare \`zunia-extension/.output/zunia-extension-${version}-firefox.zip\` with the uploaded add-on. The unpacked extension is \`zunia-extension/.output/firefox-mv3\`.

\`pnpm-lock.yaml\` is in each package. \`pnpm install --frozen-lockfile\` refuses to run if a dependency would change version.

Rebuild the Rust kernel, \`@zunialab/tokens\`, \`@zunialab/ui\`, and \`@zunialab/interchain\`. Their outputs are not in this archive. \`pnpm zip:firefox\` copies or bundles them after those commands.

## What is in here

The extension links private packages with \`pnpm.overrides\` in \`zunia-extension/package.json\`. They are not on npm, so their source is in this archive:

- \`zunia-core\`: signing kernel. Readable Rust is in \`crates/\`. \`scripts/build-wasm.sh\` writes \`packages/npm/zunia_core_bg.wasm\` and \`packages/npm/zunia_core.js\`. https://github.com/Zunia-Lab/zunia-core
- \`zunia-ui\`: wallet interface. \`packages/ui/src\` is the TypeScript. \`pnpm --filter @zunialab/ui build\` writes \`packages/ui/dist/styles.css\`, which the extension imports. \`packages/tokens/src\` is the tokens. \`packages/fonts\` is the self-hosted font files, not a download at runtime. https://github.com/Zunia-Lab/zunia-ui
- \`zunia-sdk/packages/interchain\`: route and transfer code. \`src\` is the TypeScript. \`pnpm --filter @zunialab/interchain build\` writes \`dist\`. https://github.com/Zunia-Lab/zunia-sdk

\`zunia-extension/lib/chain-catalog.generated.ts\` is readable chain data produced by \`scripts/generate-chain-catalog.mjs\`. It is not minified. Do not regenerate it for this comparison. The script calls live chain directories, so a fresh run will not match the uploaded zip. The script is in the archive so the file can be read against its inputs.

## Third-party libraries

Versions are pinned in \`zunia-extension/pnpm-lock.yaml\`. \`package.json\` is the link for the npm packages. Release tags:

- react 19.2.8 and react-dom 19.2.8: https://github.com/facebook/react/releases/tag/v19.2.8
- @noble/ciphers 2.4.0: https://github.com/paulmillr/noble-ciphers/tree/2.4.0
- @noble/curves 2.4.0: https://github.com/paulmillr/noble-curves/tree/2.4.0
- @noble/hashes 2.4.0: https://github.com/paulmillr/noble-hashes/tree/2.4.0
- @scure/base 2.4.0: https://github.com/paulmillr/scure-base/tree/2.4.0
- @scure/bip32 2.4.0: https://github.com/paulmillr/scure-bip32/tree/2.4.0
- @scure/bip39 2.4.0: https://github.com/paulmillr/scure-bip39/tree/2.4.0
- wxt 0.20.27: https://github.com/wxt-dev/wxt/tree/wxt-v0.20.27
- vite 8.2.2: https://github.com/vitejs/vite/releases/tag/v8.2.2

No library is loaded from a CDN. No library is modified.

## What the add-on does

Zunia is a non-custodial Cosmos wallet published by Zedeal Group Hub Ltd (https://zedealgroup.mu, DUNS 66-981-0013). The recovery phrase is created on the device and encrypted there. Nothing is loaded from a remote script. The content script injects \`injected.js\`, which is bundled in the extension. It does not inject a stylesheet. Version 0.1.1 had a content-script rule \`body { font-family: "Space Grotesk" }\` that replaced fonts on every site. That file is removed in 0.1.2.

\`data_collection_permissions.required\` is \`financialAndPaymentInfo\` because a broadcast sends the public address and the signed transaction to a public chain endpoint. The user can replace that endpoint. Those requests are not sent to a Zunia or Zedeal server. The extension does not collect card numbers, bank accounts, or payment history.

A Keplr-compatible \`window.keplr\` can be turned on by the user and is off by default. The extension does not use the Keplr name, logo, or listing.

There is no account to sign in to. To test: install, open the toolbar button, create a wallet. The phrase is shown on the device. Connecting a site, signing, and approving a transaction each ask for a confirmation in the extension.

## Firefox-only transform

\`zunia-extension/wxt.config.ts\` replaces React DOM's dynamic \`innerHTML\` write with \`DOMParser\` when the target is Firefox. That is part of \`pnpm zip:firefox\`. A rebuild on the environment above includes it.
`;
}
