#!/usr/bin/env node
/**
 * Builds lib/chain-catalog.generated.ts from the sibling zunia-chain-registry checkout,
 * plus a JSON copy the Flutter app bundles so both platforms read one catalog.
 * Mainnets and testnets are both emitted; icons resolve to bundled assets when present,
 * otherwise to the registry raw URL.
 *
 * Also asks the official cosmos/chain-registry (via cosmos.directory + the
 * GitHub testnets tree) whether each chain_id is listed, and asks Cosmostation
 * chainlist for the directory name their validator monikers live under. Those
 * two lookups replace the hand-maintained slug map that used to live in the
 * logo resolver.
 *
 * Usage: node scripts/generate-chain-catalog.mjs [--registry ../zunia-chain-registry]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { registry: path.resolve(rootDir, "../zunia-chain-registry") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--registry" && argv[i + 1]) {
      args.registry = path.resolve(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

const TESTNET_HINT = /(testnet|devnet|test-net|-test\b|localnet)/i;

function isTestnet(fileName, chain) {
  return (
    TESTNET_HINT.test(fileName) ||
    TESTNET_HINT.test(chain.chainName ?? "") ||
    TESTNET_HINT.test(chain.chainId ?? "")
  );
}

function slugify(value) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "");
}

function logoSlugsFor({
  chainId,
  chainName,
  identifier,
  registrySlug,
  cosmostationSlug,
}) {
  const slugs = [];
  const push = (value) => {
    const slug = slugify(value);
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  };
  push(cosmostationSlug);
  push(registrySlug);
  push(identifier);
  push(chainName?.replace(/\s+/g, ""));
  push(chainName);
  push(chainId.replace(/_\d+-\d+$/, "").replace(/-\d+$/, ""));
  push(chainId);
  return slugs;
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

async function fetchJson(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "zunia-chain-catalog" },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Official cosmos/chain-registry membership, keyed by chain_id.
 * Mainnets come from cosmos.directory (the public registry index).
 * Testnets are not in that index, so we read chain.json from GitHub.
 */
async function fetchOfficialRegistry() {
  const byChainId = new Map();
  try {
    const data = await fetchJson("https://chains.cosmos.directory/");
    for (const chain of data.chains ?? []) {
      if (typeof chain.chain_id !== "string" || !chain.chain_id) continue;
      const slug = chain.chain_name ?? chain.path ?? chain.name;
      byChainId.set(chain.chain_id, {
        chainName: slug,
        path: chain.path ?? slug,
      });
    }
  } catch (err) {
    console.warn(`  cosmos.directory: ${err.message}`);
  }

  try {
    const listing = await fetchJson(
      "https://api.github.com/repos/cosmos/chain-registry/contents/testnets",
    );
    const dirs = (Array.isArray(listing) ? listing : [])
      .filter((row) => row?.type === "dir" && typeof row.name === "string")
      .map((row) => row.name);
    await mapPool(dirs, 16, async (name) => {
      try {
        const chain = await fetchJson(
          `https://raw.githubusercontent.com/cosmos/chain-registry/master/testnets/${name}/chain.json`,
          { timeoutMs: 8_000 },
        );
        if (typeof chain.chain_id === "string" && chain.chain_id) {
          const slug = chain.chain_name ?? name;
          if (!byChainId.has(chain.chain_id)) {
            byChainId.set(chain.chain_id, { chainName: slug, path: slug });
          }
        }
      } catch {
        /* folder without chain.json */
      }
    });
  } catch (err) {
    console.warn(`  cosmos testnets: ${err.message}`);
  }

  return byChainId;
}

/** Cosmostation chainlist folder name for each cosmos chain_id. */
async function fetchCosmostationSlugs() {
  const byChainId = new Map();
  let folders = [];
  try {
    const listing = await fetchJson(
      "https://api.github.com/repos/cosmostation/chainlist/contents/chain",
    );
    folders = (Array.isArray(listing) ? listing : [])
      .filter((row) => row?.type === "dir" && typeof row.name === "string")
      .map((row) => row.name);
  } catch (err) {
    console.warn(`  cosmostation list: ${err.message}`);
    return byChainId;
  }

  await mapPool(folders, 20, async (name) => {
    try {
      const param = await fetchJson(
        `https://raw.githubusercontent.com/cosmostation/chainlist/main/chain/${name}/param_2.json`,
        { timeoutMs: 8_000 },
      );
      const id = param.chain_id_cosmos ?? param.chain_id;
      if (typeof id === "string" && id) byChainId.set(id, name);
    } catch {
      /* evm-only folder, or no param file */
    }
  });
  return byChainId;
}

function readRegistry(registryDir, official, cosmostation) {
  const chainsDir = path.join(registryDir, "cosmos");
  if (!fs.existsSync(chainsDir)) {
    throw new Error(`Registry not found at ${chainsDir}`);
  }
  const bundledIcons = new Set(
    fs.existsSync(path.join(rootDir, "public/chains"))
      ? fs.readdirSync(path.join(rootDir, "public/chains"))
      : [],
  );

  const entries = [];
  for (const file of fs.readdirSync(chainsDir).sort()) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(
      fs.readFileSync(path.join(chainsDir, file), "utf8"),
    );
    const chainId = raw.chainId;
    const prefix = raw.bech32Config?.bech32PrefixAccAddr;
    const currency = raw.currencies?.[0];
    if (!chainId || !prefix || !currency?.coinDenom) continue;

    const fee = raw.feeCurrencies?.[0] ?? currency;
    const localIcon = `${chainId}.png`;
    const identifier = file.replace(/\.json$/, "");
    const fromIcon = raw.chainSymbolImageUrl?.match(/\/images\/([^/]+)\//)?.[1];
    const officialRow = official.get(chainId);
    const registrySlug = officialRow?.chainName ?? officialRow?.path;
    entries.push({
      chainId,
      chainName: raw.chainName ?? chainId,
      bech32Prefix: prefix,
      coinType: raw.bip44?.coinType ?? 118,
      network: isTestnet(file, raw) ? "testnet" : "mainnet",
      coinDenom: currency.coinDenom,
      coinMinimalDenom: currency.coinMinimalDenom,
      coinDecimals: currency.coinDecimals ?? 6,
      feeDenom: fee.coinDenom,
      feeMinimalDenom: fee.coinMinimalDenom,
      feeDecimals: fee.coinDecimals ?? currency.coinDecimals ?? 6,
      gasPriceStep: fee.gasPriceStep,
      // Registry capability flags, carried through verbatim.
      //
      // These decide whether a chain can hold CW721 tokens at all: 118 of the
      // 332 rows declare "cosmwasm" and the NFT surface refuses to query the
      // rest. Dropping the array - which this script used to do - left every
      // client unable to tell "this chain has no CosmWasm" from "we did not
      // check", and the only honest thing a client could then render was an
      // empty list. `undefined` stays distinct from `[]`: 19 registry rows
      // publish no feature list at all, and "absent" is not "declared none".
      features: Array.isArray(raw.features) ? raw.features : undefined,
      // Only ~40% of the registry carries a price id; the rest stay unpriced.
      coinGeckoId: currency.coinGeckoId ?? raw.stakeCurrency?.coinGeckoId,
      rpc: raw.rpc,
      rest: raw.rest,
      iconPath: bundledIcons.has(localIcon) ? `/chains/${localIcon}` : undefined,
      iconUrl: raw.chainSymbolImageUrl,
      registrySlug,
      inCosmosRegistry: Boolean(officialRow),
      logoSlugs: logoSlugsFor({
        chainId,
        chainName: raw.chainName ?? chainId,
        identifier: fromIcon ?? identifier,
        registrySlug,
        cosmostationSlug: cosmostation.get(chainId),
      }),
    });
  }
  return entries;
}

function serialize(entries) {
  const lines = entries.map((e) => {
    const parts = [
      `chainId: ${JSON.stringify(e.chainId)}`,
      `chainName: ${JSON.stringify(e.chainName)}`,
      `bech32Prefix: ${JSON.stringify(e.bech32Prefix)}`,
      `coinType: ${e.coinType}`,
      `network: ${JSON.stringify(e.network)}`,
      `coinDenom: ${JSON.stringify(e.coinDenom)}`,
      `coinMinimalDenom: ${JSON.stringify(e.coinMinimalDenom)}`,
      `coinDecimals: ${e.coinDecimals}`,
      `feeDenom: ${JSON.stringify(e.feeDenom)}`,
      `feeMinimalDenom: ${JSON.stringify(e.feeMinimalDenom)}`,
      `feeDecimals: ${e.feeDecimals}`,
    ];
    if (e.gasPriceStep) {
      parts.push(`gasPriceStep: ${JSON.stringify(e.gasPriceStep)}`);
    }
    // Emitted only when the registry row has one, so `features === undefined`
    // keeps meaning "this chain publishes no list" rather than "no features".
    if (e.features) {
      parts.push(`features: ${JSON.stringify(e.features)}`);
    }
    if (e.coinGeckoId) {
      parts.push(`coinGeckoId: ${JSON.stringify(e.coinGeckoId)}`);
    }
    if (e.rpc) parts.push(`rpc: ${JSON.stringify(e.rpc)}`);
    if (e.rest) parts.push(`rest: ${JSON.stringify(e.rest)}`);
    if (e.iconPath) parts.push(`iconPath: ${JSON.stringify(e.iconPath)}`);
    if (e.iconUrl) parts.push(`iconUrl: ${JSON.stringify(e.iconUrl)}`);
    if (e.registrySlug) {
      parts.push(`registrySlug: ${JSON.stringify(e.registrySlug)}`);
    }
    parts.push(`inCosmosRegistry: ${e.inCosmosRegistry ? "true" : "false"}`);
    if (e.logoSlugs?.length) {
      parts.push(`logoSlugs: ${JSON.stringify(e.logoSlugs)}`);
    }
    return `  { ${parts.join(", ")} },`;
  });

  return `// Generated by scripts/generate-chain-catalog.mjs. Do not edit by hand.
import type { CatalogEntry } from "./chain-catalog";

export const CHAIN_CATALOG: readonly CatalogEntry[] = [
${lines.join("\n")}
];
`;
}

const { registry } = parseArgs(process.argv.slice(2));
console.log("chain catalog: resolving cosmos registry + Cosmostation slugs…");
const [official, cosmostation] = await Promise.all([
  fetchOfficialRegistry(),
  fetchCosmostationSlugs(),
]);
const entries = readRegistry(registry, official, cosmostation);
const outFile = path.join(rootDir, "lib/chain-catalog.generated.ts");
fs.writeFileSync(outFile, serialize(entries));

// Flutter and the dashboard read the same rows from a JSON copy. iconPath is
// web-only to this package, so drop it and leave them on the registry URL.
const portableJson = `${JSON.stringify(
  entries.map(({ iconPath: _iconPath, ...rest }) => rest),
  null,
  0,
)}\n`;

for (const target of [
  "../zunia-mobile/assets/chains/catalog.json",
  "../zunia-dashboard/src/data/chain-catalog.json",
]) {
  const outPath = path.resolve(rootDir, target);
  // Only write into sibling checkouts that actually exist.
  if (!fs.existsSync(path.dirname(path.dirname(outPath)))) continue;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, portableJson);
}

const mainnets = entries.filter((e) => e.network === "mainnet").length;
const listed = entries.filter((e) => e.inCosmosRegistry).length;
console.log(
  `chain catalog: ${entries.length} chains (${mainnets} mainnet, ${
    entries.length - mainnets
  } testnet) → ${path.relative(rootDir, outFile)}`,
);
console.log(
  `  cosmos chain-registry: ${listed} listed, ${
    entries.length - listed
  } not listed (${official.size} official ids, ${cosmostation.size} Cosmostation slugs)`,
);

// Printed because the NFT and swap surfaces are gated on it: a drop to zero
// here means every client silently loses CW721 support.
const cosmwasm = entries.filter((e) => e.features?.includes("cosmwasm")).length;
const noFeatures = entries.filter((e) => !e.features).length;
console.log(
  `  features: ${cosmwasm} declare cosmwasm, ${noFeatures} publish no feature list`,
);
