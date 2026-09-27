/**
 * Source archive for addons.mozilla.org.
 *
 * WXT's own sources zip is only this repository. The Firefox build also
 * compiles linked checkouts of zunia-core, zunia-ui, and zunia-sdk, so a
 * reviewer who unpacks that zip cannot run it. This script packs those
 * checkouts beside this one, with a README at the root.
 *
 * Mozilla's source rules:
 * https://extensionworkshop.com/documentation/publish/source-code-submission/
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.resolve(extensionDir, "..");
const version = JSON.parse(readFileSync(path.join(extensionDir, "package.json"), "utf8")).version;
const stage = path.join(tmpdir(), `zunia-amo-source-${version}`);
const zipPath = path.join(extensionDir, ".output", `zunia-extension-${version}-amo-source.zip`);

const skip = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  "target",
  "dist",
  "fuzz",
  ".DS_Store",
]);

function copyTree(from, to, keepDist = false) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (keepDist && name === "dist") return true;
      return !skip.has(name);
    },
  });
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

copyTree(extensionDir, path.join(stage, "zunia-extension"));
copyTree(path.join(workspace, "zunia-core/crates"), path.join(stage, "zunia-core/crates"));
copyTree(path.join(workspace, "zunia-core/packages/npm"), path.join(stage, "zunia-core/packages/npm"));
copyTree(path.join(workspace, "zunia-core/scripts"), path.join(stage, "zunia-core/scripts"));
for (const file of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "LICENSE", "README.md"]) {
  cpSync(path.join(workspace, "zunia-core", file), path.join(stage, "zunia-core", file));
}
for (const pkg of ["ui", "tokens", "fonts"]) {
  copyTree(
    path.join(workspace, "zunia-ui/packages", pkg),
    path.join(stage, "zunia-ui/packages", pkg),
  );
}
copyTree(
  path.join(workspace, "zunia-sdk/packages/interchain"),
  path.join(stage, "zunia-sdk/packages/interchain"),
);

// The extension imports these built files as-is. copyTree skips every `dist`.
copyTree(
  path.join(workspace, "zunia-ui/packages/ui/dist/styles.css"),
  path.join(stage, "zunia-ui/packages/ui/dist/styles.css"),
);
copyTree(path.join(workspace, "zunia-ui/packages/tokens/dist"), path.join(stage, "zunia-ui/packages/tokens/dist"), true);
copyTree(
  path.join(workspace, "zunia-sdk/packages/interchain/dist"),
  path.join(stage, "zunia-sdk/packages/interchain/dist"),
  true,
);

writeFileSync(path.join(stage, "README.md"), readme(version));

mkdirSync(path.dirname(zipPath), { recursive: true });
rmSync(zipPath, { force: true });
const packed = spawnSync("zip", ["-r", "-q", zipPath, "."], { cwd: stage });
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.exit(packed.status ?? 1);
}
rmSync(stage, { recursive: true, force: true });
console.log(zipPath);

function readme(version) {
  return `# Zunia ${version} source for addons.mozilla.org

This archive is the source for \`zunia-extension-${version}-firefox.zip\`.
The extension is minified by Vite, which is open source and runs on this computer. It is not obfuscated. No build step uses a website.

## Build environment

The uploaded add-on was built with:

- macOS, Darwin arm64. This is not the default reviewer image (Ubuntu 24.04.4 LTS).
- Node.js 26.3.1. The default reviewer image has Node.js 24.14.0. Install 26.3.1 or the bundle will not match: https://nodejs.org/dist/v26.3.1/
- pnpm 9.15.0, through Corepack. Do not install dependencies with npm.

\`\`\`
corepack enable
corepack prepare pnpm@9.15.0 --activate
node -v   # v26.3.1
pnpm -v   # 9.15.0
\`\`\`

## Build

From this directory, the one that contains \`zunia-extension\`, \`zunia-core\`, \`zunia-ui\`, and \`zunia-sdk\`:

\`\`\`
cd zunia-extension
pnpm install --frozen-lockfile
pnpm zip:firefox
\`\`\`

Compare \`zunia-extension/.output/zunia-extension-${version}-firefox.zip\` with the uploaded add-on. The unpacked extension is \`zunia-extension/.output/firefox-mv3\`.

\`pnpm-lock.yaml\` is in \`zunia-extension\`. \`pnpm install --frozen-lockfile\` refuses to run if a dependency would change version.

Do not rebuild the Rust kernel, \`@zunialab/interchain\`, or \`@zunialab/tokens\`. Those outputs are already in this archive, and \`pnpm zip:firefox\` copies or bundles them. Building them again with another toolchain changes the add-on zip.

## What is in here

The extension links private packages with \`pnpm.overrides\` in \`zunia-extension/package.json\`. They are included so the links resolve:

- \`zunia-core\`: the signing kernel. Readable Rust is in \`crates/\`. \`packages/npm/zunia_core_bg.wasm\` is the binary the extension copies. \`scripts/build-wasm.sh\` is how that binary is produced. https://github.com/Zunia-Lab/zunia-core
- \`zunia-ui\`: wallet interface compiled from \`packages/ui/src\`. https://github.com/Zunia-Lab/zunia-ui
- \`zunia-sdk/packages/interchain\`: route and transfer code. \`src\` is the TypeScript. \`dist\` is what the extension bundles. https://github.com/Zunia-Lab/zunia-sdk

Direct third-party libraries, versions pinned in the lockfile:

- react and react-dom: https://www.npmjs.com/package/react
- @noble/ciphers, @noble/curves, @noble/hashes: https://github.com/paulmillr/noble-cryptography
- @scure/base, @scure/bip32, @scure/bip39: https://github.com/paulmillr/scure-base
- wxt and Vite, the bundler: https://wxt.dev/ and https://vite.dev/

## Firefox-only transform

\`zunia-extension/wxt.config.ts\` replaces React DOM's dynamic \`innerHTML\` write with \`DOMParser\` when the target is Firefox. That is part of \`pnpm zip:firefox\`. A rebuild on the environment above includes it.
`;
}
