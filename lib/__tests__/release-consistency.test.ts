/**
 * Release checks that span the generated tables, the code that reads them and
 * the build scripts (release 0.1.3, WP-I). None of them pins a snapshot: each
 * says two sources agree, so a regeneration that keeps them in step passes and
 * one that lets them drift apart fails.
 *
 * - The token table (lib/token-registry.generated.ts) and the channel table
 *   (lib/ibc-channels.generated.ts) read one chain-registry commit, and no
 *   channel end leads to two places.
 * - Every erc20, peggy or gravity denom the swap To list offers is the token
 *   table's hash-verified spelling, and the planner is asked for exactly that.
 * - No code outside the deprecated naming shims and their tests uses them.
 * - The Safari app carries package.json's version.
 * - scripts/check-build.mjs refuses a stale SDK dist, a new permission, and a
 *   provider that would not report its release and features.
 * - Zunia's swap fee is 50 basis points, compiled in, and every treasury it
 *   pays decodes with its own chain's prefix.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { bech32 } from "@scure/base";
import { SEED_CHANNEL_ROUTES } from "@zunialab/interchain";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { CONNECT_CONFIG } from "../../config/connect";
import { SWAP_FEE_BPS, SWAP_FEE_RECIPIENTS } from "../../config/fees";
import { swapPlanRequest } from "../../entrypoints/popup/screens/SwapScreen";
import {
  CHAIN_CATALOG,
  allCatalogEntries,
  currenciesOf,
  denomsMatch,
  findCatalogEntry,
} from "../chain-catalog";
import { swapFeeRecipient } from "../swap-fee";
import { IBC_CHANNEL_ROWS, IBC_CHANNELS_COMMIT } from "../ibc-channels.generated";
import { osmosisSwapAssets, type OsmosisListing } from "../osmosis-assets";
import { buyOptions, sellOptions, type AssetOption } from "../swap-assets";
import { ibcDenomFor, tokenTableRows } from "../token-identity";
import { TOKEN_REGISTRY_SOURCES } from "../token-registry.generated";

const ROOT = path.resolve(__dirname, "../..");
const OSMOSIS = "osmosis-1";
const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const USDT_PEGGY = "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7";

/* -------------------------------------------------------------------------- *
 * The token table and the channel table
 * -------------------------------------------------------------------------- */

/** One end of a channel as `chain channel`, and where it leads as `chain channel`. */
const end = (chainId: string, channelId: string) => `${chainId} ${channelId}`;

describe("the token table and the channel table", () => {
  it("read the same chain-registry commit", () => {
    expect(IBC_CHANNELS_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    // Regenerate both together (pnpm tokens:generate, pnpm channels:generate):
    // a channel one table knows and the other does not names and routes apart.
    expect(TOKEN_REGISTRY_SOURCES.chainRegistry).toBe(IBC_CHANNELS_COMMIT);
  });

  it("never lead one channel end to two places", () => {
    // Every channel end either source names, with the far end it names.
    const leads = new Map<string, Set<string>>();
    const record = (from: string, to: string) => {
      const seen = leads.get(from) ?? new Set<string>();
      seen.add(to);
      leads.set(from, seen);
    };
    const channelTable = new Map<string, string>();
    for (const [source, channel, dest, counterparty] of IBC_CHANNEL_ROWS) {
      channelTable.set(end(source, channel), end(dest, counterparty));
      record(end(source, channel), end(dest, counterparty));
    }
    // The SDK's compiled-in seeds join the same route registry.
    for (const route of SEED_CHANNEL_ROUTES) {
      record(end(route.sourceChainId, route.channelId), end(route.destChainId, route.counterpartyChannelId));
    }

    let compared = 0;
    for (const row of tokenTableRows()) {
      if (!row.channelId || !row.counterpartyChainId) continue;
      const here = end(row.heldOnChainId, row.channelId);
      const listed = channelTable.get(here);
      if (row.counterpartyChannelId) {
        const there = end(row.counterpartyChainId, row.counterpartyChannelId);
        record(here, there);
        record(there, here);
        if (listed || channelTable.has(there)) compared += 1;
      } else if (listed) {
        // A row that knows only the far chain must still agree on it.
        expect(listed.split(" ")[0], `${row.heldOnChainId}:${row.denom}`).toBe(row.counterpartyChainId);
        compared += 1;
      }
    }

    const conflicts = [...leads]
      .filter(([, places]) => places.size > 1)
      .map(([from, places]) => `${from} -> ${[...places].join(" | ")}`);
    expect(conflicts).toEqual([]);
    // Not vacuous: most of the table's first hops cross a registry channel.
    expect(compared).toBeGreaterThan(200);
  });
});

/* -------------------------------------------------------------------------- *
 * Swap destinations
 * -------------------------------------------------------------------------- */

/** Denoms whose exact case is part of the hash: an Ethereum address, mixed case on chain. */
const EVM_DENOM = /^(?:erc20[:/]|peggy0x|gravity0x)/i;

/** What SQS would list if it listed every row the table has on Osmosis: the widest To list. */
function everyOsmosisListing(): OsmosisListing[] {
  return tokenTableRows(OSMOSIS).map((row) => ({
    denom: row.denom,
    symbol: row.denom,
    name: row.denom,
    decimals: row.decimals,
    coinGeckoId: null,
  }));
}

describe("swap destinations", () => {
  const osmosis = osmosisSwapAssets(everyOsmosisListing());
  const options = buyOptions([], {}, { from: null, osmosis, routes: null });
  const offered = new Set(options.map((option) => option.key));
  const evm = options.filter((option) => EVM_DENOM.test(option.denom));

  it("offer an erc20, peggy or gravity denom only in the token table's hash-verified spelling", () => {
    expect(evm.map((option) => option.key)).toEqual(
      expect.arrayContaining([`injective-1:${USDC_INJ_ERC20}`, `injective-1:${USDT_PEGGY}`]),
    );
    for (const option of evm) {
      // Nothing is held here, so the row is a delivery home from Osmosis.
      expect(option.held, option.key).toBe(false);
      const voucher = tokenTableRows(OSMOSIS).find((row) => row.denom === option.identity.osmosisDenom);
      expect(voucher, option.key).toBeDefined();
      if (!voucher) continue;
      // The table's row, exact case, verified and listed as stable by Osmosis.
      expect([voucher.originChainId, voucher.originDenom], option.key).toEqual([option.chainId, option.denom]);
      expect(voucher.verified && voucher.stable, option.key).toBe(true);
      // Hash-verified: the voucher is sha256 of its trace, and one plain hop
      // back over its channel delivers exactly this denom.
      expect(ibcDenomFor(voucher.path, voucher.baseDenom), option.key).toBe(voucher.denom);
      expect(voucher.path, option.key).toBe(`transfer/${voucher.channelId}`);
      expect(ibcDenomFor(voucher.path, option.denom), option.key).toBe(voucher.denom);
      // That channel is one the channel table lists, in both directions.
      const pairs = IBC_CHANNEL_ROWS.map((row) => row.join(" "));
      expect(pairs, option.key).toContain(
        [OSMOSIS, voucher.channelId, option.chainId, voucher.counterpartyChannelId].join(" "),
      );
      expect(pairs, option.key).toContain(
        [option.chainId, voucher.counterpartyChannelId, OSMOSIS, voucher.channelId].join(" "),
      );
    }
  });

  it("never offer the catalog's spelling when it differs from the table's", () => {
    let differing = 0;
    for (const entry of allCatalogEntries()) {
      for (const currency of currenciesOf(entry)) {
        const spelling = currency.coinMinimalDenom;
        if (!EVM_DENOM.test(spelling)) continue;
        const exact = evm.find((option) => option.chainId === entry.chainId && denomsMatch(option.denom, spelling));
        if (!exact || exact.denom === spelling) continue;
        differing += 1;
        // Injective's USDC: the catalog's lowercase string hashes to ibc/D3B2…,
        // an empty denom, instead of the ibc/794C… Osmosis trades.
        expect(offered.has(`${entry.chainId}:${spelling}`), `${entry.chainId}:${spelling}`).toBe(false);
      }
    }
    expect(differing).toBeGreaterThan(0);
  });

  it("ask the planner for exactly the offered chain and denom", () => {
    const [from] = sellOptions(
      [{ chainId: "cosmoshub-4", entry: findCatalogEntry("cosmoshub-4")! }],
      { "cosmoshub-4": { tokens: [{ denom: "uatom", amount: "1000000" }] } },
    );
    expect(from).toBeDefined();
    for (const to of evm) {
      const request = swapPlanRequest({
        from: from as AssetOption,
        to,
        amountUnits: 1_000_000n,
        sender: "cosmos1sender",
        recipient: "recipient",
        recoveryAddress: "osmo1recovery",
        slippagePercent: 1,
        venue: { chainId: OSMOSIS, contractAddress: "osmo1xcs", label: "Osmosis" },
        manualChannels: [],
        resolveAddresses: async () => ({}),
      });
      expect([request.destChainId, request.destDenom], to.key).toEqual([to.chainId, to.denom]);
      expect(request.expectedVenueOutputDenom, to.key).toBe(to.identity.osmosisDenom);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Deprecated naming helpers
 * -------------------------------------------------------------------------- */

/** Global first-match lookups that named Noble USDC as Axelar's. lib/chain-catalog.ts keeps them as shims. */
const DEPRECATED = new Set(["findCurrency", "findCatalogByMinimalDenom", "displayCoinSymbol"]);
const SHIM_FILE = "lib/chain-catalog.ts";
const SOURCE_ROOTS = ["lib", "entrypoints", "config", "types"];

function parse(file: string, text: string): ts.SourceFile {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Every identifier naming a deprecated helper, as `file:line name`: calls,
 * imports, re-exports and references. Comments and strings are not code, so
 * they are not read. The shims' own declarations are allowed.
 */
function deprecatedUses(file: string, text: string): string[] {
  const source = parse(file, text);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && DEPRECATED.has(node.text)) {
      const declaration =
        file === SHIM_FILE && ts.isFunctionDeclaration(node.parent) && node.parent.name === node;
      if (!declaration) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        out.push(`${file}:${line + 1} ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Source files outside tests, relative to the repo root. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(rel);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(rel);
      }
    }
  };
  for (const root of SOURCE_ROOTS) walk(root);
  return out;
}

describe("the deprecated naming helpers", () => {
  it("are found by the scan in code, not in comments or strings", () => {
    const text = [
      'import { findCurrency } from "../chain-catalog";',
      "// findCurrency(denom) used to name this token",
      "/** {@link displayCoinSymbol} is deprecated */",
      'const label = "findCatalogByMinimalDenom";',
      'export { displayCoinSymbol } from "../chain-catalog";',
      "const row = catalog.findCatalogByMinimalDenom(denom);",
      "const ok = findCurrencyOn(chainId, denom);",
    ].join("\n");
    expect(deprecatedUses("lib/example.ts", text)).toEqual([
      "lib/example.ts:1 findCurrency",
      "lib/example.ts:5 displayCoinSymbol",
      "lib/example.ts:6 findCatalogByMinimalDenom",
    ]);
  });

  it("are used by no code outside their own definitions and tests", () => {
    const files = sourceFiles();
    expect(files).toContain(SHIM_FILE);
    expect(files.length).toBeGreaterThan(100);
    const uses = files.flatMap((file) => deprecatedUses(file, fs.readFileSync(path.join(ROOT, file), "utf8")));
    expect(uses).toEqual([]);
  });

  it("are still declared, and marked deprecated, in lib/chain-catalog.ts", () => {
    const source = parse(SHIM_FILE, fs.readFileSync(path.join(ROOT, SHIM_FILE), "utf8"));
    const marked = source.statements
      .filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.name && DEPRECATED.has(fn.name.text) && ts.getJSDocDeprecatedTag(fn))
      .map((fn) => fn.name!.text)
      .sort();
    expect(marked).toEqual([...DEPRECATED].sort());
  });
});

/* -------------------------------------------------------------------------- *
 * Zunia's swap fee
 * -------------------------------------------------------------------------- */

/**
 * Why each entry of a treasury map cannot be paid, as `chainId: reason`: the
 * chain must be one the release bundles, and the address must decode as
 * bech32, checksum included, in lowercase, with exactly the prefix the
 * catalog gives that chain, holding an account's 20 bytes or a contract's 32.
 *
 * And no coin type 60 chain's treasury may carry the same bytes as another
 * coin type's: Injective and the other Ethereum-key chains hash their keys
 * another way, so those bytes can only be another chain's address re-encoded
 * with a new prefix, an account nobody can spend from.
 *
 * Written here on its own, apart from lib/swap-fee.ts, so the release does not
 * check the code with itself.
 */
function treasuryProblems(map: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const decodedRows: { chainId: string; coinType: number; hex: string }[] = [];
  for (const [chainId, address] of Object.entries(map)) {
    const entry = CHAIN_CATALOG.find((row) => row.chainId === chainId);
    if (!entry) {
      problems.push(`${chainId}: not a bundled chain`);
      continue;
    }
    let decoded: { prefix: string; bytes: Uint8Array };
    try {
      decoded = bech32.decodeToBytes(address);
    } catch (error) {
      problems.push(`${chainId}: ${address} does not decode (${(error as Error).message})`);
      continue;
    }
    if (decoded.prefix !== entry.bech32Prefix) {
      problems.push(`${chainId}: ${address} has the prefix ${decoded.prefix}, the chain's is ${entry.bech32Prefix}`);
    }
    if (address !== address.toLowerCase()) problems.push(`${chainId}: ${address} is not lowercase`);
    if (decoded.bytes.length !== 20 && decoded.bytes.length !== 32) {
      problems.push(`${chainId}: ${address} holds ${decoded.bytes.length} bytes`);
    }
    decodedRows.push({ chainId, coinType: entry.coinType, hex: Buffer.from(decoded.bytes).toString("hex") });
  }
  for (const row of decodedRows) {
    if (row.coinType !== 60) continue;
    const twin = decodedRows.find((other) => other.coinType !== 60 && other.hex === row.hex);
    if (twin) problems.push(`${row.chainId}: re-encodes ${twin.chainId}'s treasury, which no coin type 60 key can spend`);
  }
  return problems;
}

describe("Zunia's swap fee", () => {
  it("is 50 basis points of the amount sold", () => {
    expect(SWAP_FEE_BPS).toBe(50);
  });

  it("pays only treasuries that decode with their own chain's prefix", () => {
    expect(treasuryProblems(SWAP_FEE_RECIPIENTS)).toEqual([]);
    // And the wallet pays each one exactly as configured: none is dropped as
    // invalid at run time, which would silently charge nothing there.
    for (const [chainId, address] of Object.entries(SWAP_FEE_RECIPIENTS)) {
      expect(swapFeeRecipient(chainId), chainId).toBe(address);
    }
  });

  it("would refuse a wrong-chain, mistyped, re-encoded or unbundled treasury", () => {
    const bytes = (fill: number) => bech32.toWords(new Uint8Array(20).fill(fill));
    const osmo = bech32.encode("osmo", bytes(0x5a));
    // One key on two coin type 118 chains is one account: the same bytes are fine there.
    expect(
      treasuryProblems({
        "osmosis-1": osmo,
        "cosmoshub-4": bech32.encode("cosmos", bytes(0x5a)),
        "injective-1": bech32.encode("inj", bytes(0x5b)),
      }),
    ).toEqual([]);
    // Osmosis's treasury re-encoded for Injective: right prefix, unspendable account.
    expect(treasuryProblems({ "osmosis-1": osmo, "injective-1": bech32.encode("inj", bytes(0x5a)) })).toEqual([
      "injective-1: re-encodes osmosis-1's treasury, which no coin type 60 key can spend",
    ]);
    expect(
      treasuryProblems({
        "cosmoshub-4": osmo,
        "osmosis-1": `${osmo.slice(0, -1)}${osmo.endsWith("q") ? "p" : "q"}`,
        "noble-1": bech32.encode("noble", bech32.toWords(new Uint8Array(16).fill(1))),
        "my-chain-1": osmo,
      }).map((problem) => problem.split(":")[0]),
    ).toEqual(["cosmoshub-4", "osmosis-1", "noble-1", "my-chain-1"]);
  });

  it("is compiled in: config/fees.ts imports nothing and lib/swap-fee.ts reads no network or storage", () => {
    const imports = (file: string) => {
      const source = parse(file, fs.readFileSync(path.join(ROOT, file), "utf8"));
      return source.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    };
    expect(imports("config/fees.ts")).toEqual([]);
    expect(imports("lib/swap-fee.ts").sort()).toEqual(
      ["../config/fees", "./chain-catalog", "@scure/base", "@zunialab/interchain"].sort(),
    );
    const fee = fs.readFileSync(path.join(ROOT, "lib/swap-fee.ts"), "utf8");
    expect(fee).not.toMatch(/\bfetch\(|\bbrowser\.|\bchrome\.|localStorage|getSettings/);
  });
});

/* -------------------------------------------------------------------------- *
 * The Safari app
 * -------------------------------------------------------------------------- */

describe("the Safari app", () => {
  it("carries package.json's version on every target", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string };
    const pbxproj = fs.readFileSync(path.join(ROOT, "safari/Zunia/Zunia.xcodeproj/project.pbxproj"), "utf8");
    // A target's configuration names its bundle; the project-wide ones do not.
    const targets = pbxproj
      .split(/isa = XCBuildConfiguration;/)
      .slice(1)
      .map((block) => block.slice(0, block.indexOf("name = ")))
      .filter((block) => block.includes("PRODUCT_BUNDLE_IDENTIFIER"));
    // The app and its extension, for macOS and iOS, Debug and Release.
    expect(targets).toHaveLength(8);
    for (const block of targets) {
      expect(block.match(/MARKETING_VERSION = ([^;]+);/)?.[1]).toBe(version);
      expect(block.match(/CURRENT_PROJECT_VERSION = ([^;]+);/)?.[1]).toBe(version);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * scripts/check-build.mjs
 * -------------------------------------------------------------------------- */

/**
 * What the provider bundle carries about itself (lib/provider-identity.ts): the
 * read of the release the content script hands over, and the feature strings.
 */
const providerBundle = (features: readonly string[]) =>
  `const r=document.currentScript?.dataset.zuniaVersion;const f=Object.freeze(${JSON.stringify(features)});\n`;
/** The content script's side: it writes the release into the script tag. */
const CONTENT_BUNDLE = "s.dataset.zuniaVersion=chrome.runtime.getManifest().version;\n";

/**
 * A scratch copy of the workspace layout check-build reads: the script, the
 * connect config it reads the provider's features from, a linked zunia-sdk
 * interchain package with src and dist, and one Chrome build that passes every
 * check.
 */
function scratchWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "zunia-check-build-"));
  const ext = path.join(base, "zunia-extension");
  const sdk = path.join(base, "zunia-sdk", "packages", "interchain");
  const build = path.join(ext, ".output", "chrome-mv3");
  const config = path.join(ext, "config", "connect.ts");
  const write = (file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write(path.join(ext, "scripts", "check-build.mjs"), fs.readFileSync(path.join(ROOT, "scripts/check-build.mjs")));
  write(config, fs.readFileSync(path.join(ROOT, "config/connect.ts")));
  write(path.join(sdk, "src", "route.ts"), "export const route = 1;\n");
  write(path.join(sdk, "dist", "index.js"), "export const route = 1;\n");
  fs.mkdirSync(path.join(ext, "node_modules", "@zunialab"), { recursive: true });
  fs.symlinkSync(sdk, path.join(ext, "node_modules", "@zunialab", "interchain"), "dir");

  const manifest = {
    manifest_version: 3,
    name: "Zunia",
    version: "0.1.3",
    permissions: ["storage", "alarms", "idle"],
    optional_permissions: ["notifications"],
    host_permissions: ["http://localhost/*", "https://api.zunialab.com/*"],
    optional_host_permissions: ["https://*/*", "wss://*/*"],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
    background: { service_worker: "background.js" },
    web_accessible_resources: [{ resources: ["injected.js", "connect.html"], matches: ["https://*/*"] }],
    externally_connectable: { matches: ["https://zunialab.com/*"] },
    content_scripts: [{ matches: ["https://*/*"], js: ["content-scripts/content.js"] }],
  };
  for (const file of ["background.js", "chunks/swap.js"]) {
    write(path.join(build, file), "console.log(1);\n");
  }
  write(path.join(build, "injected.js"), providerBundle(CONNECT_CONFIG.provider.features));
  write(path.join(build, "content-scripts", "content.js"), CONTENT_BUNDLE);
  for (const file of ["popup.html", "connect.html", "onboarding.html"]) {
    write(path.join(build, file), '<!doctype html><script type="module" src="/chunks/swap.js"></script>\n');
  }
  write(path.join(build, "zunia_core_bg.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  const writeManifest = (value: unknown) => write(path.join(build, "manifest.json"), JSON.stringify(value));
  writeManifest(manifest);

  // src, then the dist built from it, then the extension built from that.
  const at = (file: string, seconds: number) => fs.utimesSync(file, seconds, seconds);
  const T = Math.floor(Date.now() / 1000) - 3600;
  at(path.join(sdk, "src", "route.ts"), T);
  at(path.join(sdk, "dist", "index.js"), T + 60);
  at(path.join(build, "manifest.json"), T + 120);

  const run = () => {
    const result = spawnSync(process.execPath, [path.join(ext, "scripts", "check-build.mjs"), "chrome"], {
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  return { base, sdk, build, config, manifest, writeManifest, at, T, run };
}

describe("scripts/check-build.mjs", () => {
  const made: string[] = [];
  const workspace = () => {
    const scratch = scratchWorkspace();
    made.push(scratch.base);
    return scratch;
  };
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes a build made from a dist newer than its source", () => {
    const { run } = workspace();
    const result = run();
    expect(result.output).toContain("ok   @zunialab/interchain dist");
    expect(result.output).toContain(`ok   config/connect.ts lists ${CONNECT_CONFIG.provider.features.length} provider features`);
    expect(result.output).toContain("ok   chrome-mv3");
    expect(result.status).toBe(0);
  });

  it("fails when injected.js lacks a feature config/connect.ts lists", () => {
    const { build, at, T, run } = workspace();
    const [dropped, ...kept] = CONNECT_CONFIG.provider.features;
    // A bundle built before the feature existed, carrying the others.
    fs.writeFileSync(path.join(build, "injected.js"), providerBundle(kept));
    at(path.join(build, "manifest.json"), T + 120);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain(`injected.js lacks the provider feature(s) ${dropped} that config/connect.ts lists`);
  });

  it("fails when the provider would not say which release it is", () => {
    for (const [file, text, expected] of [
      [
        "injected.js",
        `const f=${JSON.stringify(CONNECT_CONFIG.provider.features)};\n`,
        "injected.js does not read the release from data-zunia-version",
      ],
      [
        "content-scripts/content.js",
        "console.log(1);\n",
        "no content script sets data-zunia-version, so window.zunia.extensionVersion would be empty",
      ],
    ] as const) {
      const { build, at, T, run } = workspace();
      fs.writeFileSync(path.join(build, file), text);
      at(path.join(build, "manifest.json"), T + 120);
      const result = run();
      expect(result.status, expected).toBe(1);
      expect(result.output).toContain(expected);
    }
  });

  it("fails when config/connect.ts lists no provider features", () => {
    const { config, run } = workspace();
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(/\bfeatures:\s*\[[^\]]*\]/, "features: []"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/FAIL config\/connect\.ts\s+- provider\.features is missing or empty/);
  });

  it("fails when an SDK source file is newer than dist/index.js", () => {
    const { sdk, at, T, run } = workspace();
    // Touching a file in src is enough: nothing proves the dist has it.
    at(path.join(sdk, "src", "route.ts"), T + 90);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/FAIL @zunialab\/interchain dist[\s\S]*is older than 1 file\(s\) in .*: route\.ts/);
  });

  it("fails when the build predates the SDK dist it should bundle", () => {
    const { build, at, T, run } = workspace();
    at(path.join(build, "manifest.json"), T + 30);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("built before the @zunialab/interchain dist it should bundle");
  });

  it("fails when a bundle still has the stale SDK's refusal", () => {
    const { build, at, T, run } = workspace();
    fs.writeFileSync(
      path.join(build, "chunks", "swap.js"),
      'throw new Error("Swapping from Osmosis takes two transactions and is not planned as one route");\n',
    );
    at(path.join(build, "manifest.json"), T + 120);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.output).toContain("chunks/swap.js still says");
  });

  it("fails on a permission, host or injection pattern 0.1.2 did not ask for", () => {
    for (const [change, expected] of [
      [{ permissions: ["storage", "alarms", "idle", "tabs"] }, 'unexpected permission "tabs"'],
      [{ optional_permissions: ["notifications", "clipboardRead"] }, 'unexpected optional_permissions entry "clipboardRead"'],
      [{ host_permissions: ["https://*/*"] }, 'unexpected host_permissions entry "https://*/*"'],
      [{ optional_host_permissions: ["<all_urls>"] }, 'unexpected optional_host_permissions entry "<all_urls>"'],
      [
        { content_scripts: [{ matches: ["http://*/*"], js: ["content-scripts/content.js"] }] },
        'unexpected content_scripts matches entry "http://*/*"',
      ],
    ] as const) {
      const { manifest, writeManifest, build, at, T, run } = workspace();
      writeManifest({ ...manifest, ...change });
      at(path.join(build, "manifest.json"), T + 120);
      const result = run();
      expect(result.status, expected).toBe(1);
      expect(result.output).toContain(expected);
    }
  });
});
