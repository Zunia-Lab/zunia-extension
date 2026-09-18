#!/usr/bin/env node
/**
 * Builds lib/chain-catalog.generated.ts from the sibling zunia-chain-registry checkout,
 * plus a JSON copy the Flutter app bundles so both platforms read one catalog.
 * Mainnets and testnets are both emitted; icons resolve to bundled assets when present,
 * otherwise to the registry raw URL.
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

function readRegistry(registryDir) {
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
const entries = readRegistry(registry);
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
console.log(
  `chain catalog: ${entries.length} chains (${mainnets} mainnet, ${
    entries.length - mainnets
  } testnet) → ${path.relative(rootDir, outFile)}`,
);

// Printed because the NFT and swap surfaces are gated on it: a drop to zero
// here means every client silently loses CW721 support.
const cosmwasm = entries.filter((e) => e.features?.includes("cosmwasm")).length;
const noFeatures = entries.filter((e) => !e.features).length;
console.log(
  `  features: ${cosmwasm} declare cosmwasm, ${noFeatures} publish no feature list`,
);
