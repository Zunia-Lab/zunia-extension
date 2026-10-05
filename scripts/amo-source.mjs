/**
 * Source archive for addons.mozilla.org.
 *
 * Each of the four repositories goes in as git tracks it: the paths
 * `git ls-files` lists, read from the working tree the add-on was built from,
 * so uncommitted edits to tracked files are included. Nothing git ignores goes
 * in: no Xcode or Flutter state from this machine, no npm facade that
 * zunia-core's build-wasm.sh writes, no stray .env. And no build output: no
 * dist/, no .wasm, no wasm-bindgen glue, no node_modules. Reviewers rebuild
 * that output with the commands in the README.
 *
 * A few tracked paths are left out too, because the Firefox build never reads
 * them: the prebuilt iOS static libraries of zunia-core's Flutter plugin
 * (`*.a`, `*.xcframework`, 25 MB each) and tool state a repository happens to
 * commit (`.dart_tool/`, `.DS_Store`). Untracked files are not packed; the
 * script lists them, in case one is a new source file that needs committing.
 *
 * Usage: node scripts/amo-source.mjs [--out <zip>]
 * The default output is .output/zunia-extension-<version>-amo-source.zip.
 *
 * https://extensionworkshop.com/documentation/publish/source-code-submission/
 */
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(extensionDir, "..");
const version = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8")).version;
const outFlag = process.argv.indexOf("--out");
const zipPath =
  outFlag > 0 && process.argv[outFlag + 1]
    ? path.resolve(process.argv[outFlag + 1])
    : path.join(extensionDir, ".output", `zunia-extension-${version}-amo-source.zip`);
// Unique, so two runs (a release and a check) cannot pack each other's files.
const stage = mkdtempSync(path.join(tmpdir(), `zunia-amo-source-${version}-`));

/** In the archive, in this order, each from its own git checkout. */
const REPOS = ["zunia-extension", "zunia-core", "zunia-ui", "zunia-sdk"];

/** Build output and caches. Git ignores them; this is the second lock. */
const BUILD_DIRS = new Set([
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
const BINDGEN_OUTPUT = new Set(["zunia_core.js", "zunia_core.d.ts", "zunia_core_bg.wasm.d.ts"]);

/**
 * Why a tracked path stays out of the archive, or null when it goes in. Also
 * applied to the staged tree and to the zip listing, so every layer agrees.
 */
function leftOut(rel) {
  const parts = rel.split(/[\\/]/);
  const name = parts[parts.length - 1];
  if (parts.some((part) => part.endsWith(".xcframework")) || name.endsWith(".a")) {
    return "prebuilt iOS library (Flutter plugin only)";
  }
  if (parts.includes(".dart_tool") || parts.includes("xcuserdata") || name === ".DS_Store") {
    return "local tool state";
  }
  if (parts.slice(0, -1).some((part) => BUILD_DIRS.has(part)) || BINDGEN_OUTPUT.has(name)) {
    return "build output";
  }
  if (/\.(wasm|map|zip)$/.test(name) || name.endsWith(".min.js")) return "build output";
  return null;
}

/**
 * Credentials never go to a store, whatever git tracks. `.env.example` is the
 * documented template and holds no values.
 */
function looksSecret(rel) {
  const name = rel.split(/[\\/]/).pop() ?? "";
  if (name === ".env.example") return false;
  return (
    /^\.env(\..+)?$/.test(name) ||
    /\.(pem|key|p12|pfx|keystore|jks|mobileprovision)$/i.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)
  );
}

function fail(message) {
  console.error(message);
  rmSync(stage, { recursive: true, force: true });
  process.exit(1);
}

/** NUL-separated so any file name survives. */
function gitPaths(repoDir, args) {
  const result = spawnSync("git", ["-C", repoDir, "ls-files", "-z", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    fail(`git ls-files failed in ${repoDir}; the archive is built from git checkouts.\n${result.stderr}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}

/** Copy one repository's tracked files into the stage. */
function packRepo(name) {
  const repoDir = path.join(workspace, name);
  const skipped = new Map();
  const missing = [];
  const secrets = [];
  let packed = 0;
  for (const rel of gitPaths(repoDir, ["--cached"])) {
    const reason = leftOut(rel);
    if (reason) {
      skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
      continue;
    }
    if (looksSecret(rel)) {
      secrets.push(rel);
      continue;
    }
    const from = path.join(repoDir, rel);
    const info = lstatSync(from, { throwIfNoEntry: false });
    // Deleted in the working tree but not in git: the build did not see it.
    if (!info) {
      missing.push(rel);
      continue;
    }
    if (!info.isFile()) {
      fail(`${name}/${rel} is a ${info.isSymbolicLink() ? "symbolic link" : "submodule"}, which this script does not pack. Add support for it first.`);
    }
    const to = path.join(stage, name, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    // Keeps the mode, so scripts/build-wasm.sh stays executable.
    copyFileSync(from, to);
    packed += 1;
  }
  if (secrets.length > 0) {
    fail(`${name} tracks files that look like credentials; refusing to pack them:\n${secrets.map((rel) => `  ${rel}`).join("\n")}`);
  }
  const untracked = gitPaths(repoDir, ["--others", "--exclude-standard"]).filter((rel) => !leftOut(rel));
  const notes = [...skipped].map(([reason, count]) => `${count} ${reason}`);
  if (missing.length > 0) notes.push(`${missing.length} deleted in the working tree`);
  console.log(`${name}: ${packed} files${notes.length > 0 ? ` (left out: ${notes.join(", ")})` : ""}`);
  if (untracked.length > 0) {
    console.warn(`${name}: not packed, git does not track them:\n${untracked.map((rel) => `  ${rel}`).join("\n")}`);
  }
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

/** The upstream commits the two generated tables were read at, from the tables themselves. */
function pinnedInputs() {
  const lib = path.join(extensionDir, "lib");
  const tokens = readFileSync(path.join(lib, "token-registry.generated.ts"), "utf8");
  const channels = readFileSync(path.join(lib, "ibc-channels.generated.ts"), "utf8");
  const sha = (text, pattern) => pattern.exec(text)?.[1] ?? null;
  const pins = {
    assetlists: sha(tokens, /osmosisAssetlists: "([0-9a-f]{40})"/),
    chainRegistry: sha(tokens, /chainRegistry: "([0-9a-f]{40})"/),
    zuniaRegistry: sha(tokens, /zuniaChainRegistry: "([0-9a-f]{40})"/),
    channels: sha(channels, /IBC_CHANNELS_COMMIT = "([0-9a-f]{40})"/),
  };
  const unread = Object.entries(pins).filter(([, value]) => !value);
  if (unread.length > 0) {
    fail(`could not read the pinned commit for ${unread.map(([key]) => key).join(", ")} from lib/*.generated.ts; update pinnedInputs() in scripts/amo-source.mjs`);
  }
  return pins;
}

for (const name of REPOS) packRepo(name);

const forbidden = walk(stage)
  .map((file) => path.relative(stage, file))
  .filter((rel) => leftOut(rel) || looksSecret(rel));
if (forbidden.length > 0) {
  fail(`source archive still contains files it must not:\n${forbidden.map((rel) => `  ${rel}`).join("\n")}`);
}

const env = {
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  pnpm: toolVersion("pnpm", ["-v"]),
  rustc: toolVersion("rustc", ["--version"]),
  bindgen: toolVersion("wasm-bindgen", ["--version"]),
  wasmOpt: toolVersion("wasm-opt", ["--version"]),
};

writeFileSync(path.join(stage, "README.md"), readme(version, env, pinnedInputs()));
const buildScript = path.join(stage, "build.sh");
writeFileSync(buildScript, buildSh());
chmodSync(buildScript, 0o755);

mkdirSync(path.dirname(zipPath), { recursive: true });
rmSync(zipPath, { force: true });
const zipped = spawnSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: stage, encoding: "utf8" });
if (zipped.status !== 0) fail(`zip failed:\n${zipped.stderr}`);

const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
if (listing.status !== 0) fail(`could not list ${zipPath}:\n${listing.stderr}`);
const leaked = listing.stdout
  .split("\n")
  .filter(Boolean)
  .filter((entry) => leftOut(entry) || looksSecret(entry));
if (leaked.length > 0) {
  rmSync(zipPath, { force: true });
  fail(`zip listing still contains files it must not:\n${leaked.map((entry) => `  ${entry}`).join("\n")}`);
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

function readme(version, env, pins) {
  const wasmOpt = env.wasmOpt
    ? `wasm-opt is installed (${env.wasmOpt}). \`scripts/build-wasm.sh\` runs \`wasm-opt -Oz\` when the command exists, and the uploaded add-on was built that way. Install binaryen so \`wasm-opt\` is on PATH before building. Without it the .wasm bytes differ.`
    : `wasm-opt was not on PATH for this build, so \`scripts/build-wasm.sh\` kept the unoptimised module. Do not install wasm-opt before rebuilding, or the .wasm bytes will differ.`;

  return `# Zunia ${version} source for addons.mozilla.org

This archive is the source for \`zunia-extension-${version}-firefox.zip\`.
Upload that zip as the add-on file. Upload this archive as the source code for the same version.

The extension the user installs is minified by Vite. Vite is open source and runs on the reviewer's computer. The code is not obfuscated. No build step uses a website.

This archive does not contain that minified output. It does not contain \`dist/\`, WebAssembly binaries, or wasm-bindgen glue. Those files are produced by the commands below.

Each of the four folders holds the files its git repository tracks, as they were when the add-on was built. Nothing git ignores is included. Two kinds of tracked file are left out because the Firefox build never reads them: prebuilt iOS static libraries (\`*.a\` and \`*.xcframework\`, which only the Flutter plugin in \`zunia-core/packages/dart\` links) and tool state (\`.dart_tool/\`, \`.DS_Store\`).

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

- \`zunia-core\`: signing kernel. Readable Rust is in \`crates/\`. \`scripts/build-wasm.sh\` writes the whole \`packages/npm\` package: the module \`zunia_core_bg.wasm\`, its wasm-bindgen glue \`zunia_core.js\`, and the readable entry files \`index.js\`, \`index.d.ts\`, \`node/\` and \`package.json\`, from the script itself. https://github.com/Zunia-Lab/zunia-core
- \`zunia-ui\`: wallet interface. \`packages/ui/src\` is the TypeScript. \`pnpm --filter @zunialab/ui build\` writes \`packages/ui/dist/styles.css\`, which the extension imports. \`packages/tokens/src\` is the tokens. \`packages/fonts\` is the self-hosted font files, not a download at runtime. https://github.com/Zunia-Lab/zunia-ui
- \`zunia-sdk/packages/interchain\`: route and transfer code. \`src\` is the TypeScript. \`pnpm --filter @zunialab/interchain build\` writes \`dist\`. https://github.com/Zunia-Lab/zunia-sdk

## Generated data tables

Three files in \`zunia-extension/lib\` are data that a script in \`zunia-extension/scripts\` generated. They are committed with the source and are readable TypeScript, not minified. The build reads them as they are: do not regenerate them to compare the add-on.

- \`chain-catalog.generated.ts\` is chain data from \`scripts/generate-chain-catalog.mjs\` (\`pnpm chains:generate\`). The script calls live chain directories and has no pinned mode, so a fresh run will not match the uploaded zip. The script is in the archive so the file can be read against its inputs.
- \`token-registry.generated.ts\` names IBC tokens. It comes from \`scripts/generate-token-registry.mjs\` (\`pnpm tokens:generate\`), and \`TOKEN_REGISTRY_SOURCES\` at its top records the commits it read: osmosis-labs/assetlists ${pins.assetlists}, cosmos/chain-registry ${pins.chainRegistry}, and Zunia-Lab/zunia-chain-registry ${pins.zuniaRegistry}. A row for an \`ibc/\` denom is kept only when the SHA-256 of its trace path equals the hash in the denom.
- \`ibc-channels.generated.ts\` lists, for each pair of mainnets in the chain catalog, the transfer channel that the chain registry marks preferred and active. It comes from \`scripts/generate-ibc-channels.mjs\` (\`pnpm channels:generate\`), and \`IBC_CHANNELS_COMMIT\` records the cosmos/chain-registry commit it read: ${pins.channels}. The wallet checks a channel on both chains before it signs a transfer over it.

Both tables can be checked against their inputs. Regenerate them at the recorded commits, which needs network access to GitHub, and compare. The token script also reads a checkout of zunia-chain-registry next to \`zunia-extension\`:

\`\`\`
cd zunia-extension
cp lib/token-registry.generated.ts lib/ibc-channels.generated.ts /tmp/
git clone https://github.com/Zunia-Lab/zunia-chain-registry ../zunia-chain-registry
git -C ../zunia-chain-registry checkout ${pins.zuniaRegistry}
pnpm tokens:generate --pinned
pnpm channels:generate --ref ${pins.channels}
diff /tmp/token-registry.generated.ts lib/token-registry.generated.ts
diff /tmp/ibc-channels.generated.ts lib/ibc-channels.generated.ts
\`\`\`

\`--pinned\` reads the commits from the file that is already there, so run it before anything replaces that file. Without \`--pinned\` and \`--ref\`, both scripts read the latest upstream commits, and the output will differ.

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
