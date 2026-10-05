#!/usr/bin/env node
/**
 * Builds lib/token-registry.generated.ts: the hash-verified token table that
 * lib/token-identity.ts names IBC vouchers from, plus a logo map for the
 * catalog's own currencies.
 *
 * Why a build-time table: an `ibc/HASH` denom says nothing about where the
 * token came from. The wallet used to guess the issuer from the base denom
 * alone, so Noble USDC on Osmosis read as Axelar's `USDC.axl`. The upstream
 * lists below name each voucher's issuer, and every row is kept only if
 * sha256(trace path) reproduces its hash, which also proves the exact case of
 * the base denom (Injective's `erc20:0xa00C…` is mixed case on chain; the
 * catalog's lowercase spelling hashes to a different, empty denom).
 *
 * Inputs, each pinned by commit in the generated header so a re-run with the
 * same SHAs produces no diff:
 * - osmosis-labs/assetlists `osmosis-1/generated/frontend/assetlist.json`:
 *   every token Osmosis lists, with its issuer chain, the exact source denom
 *   and the transfer channel pair. Verified rows only.
 * - cosmos/chain-registry `<chain>/assetlist.json` and `<chain>/chain.json`:
 *   the IBC vouchers of the hub chains (including the ones a bridge minted
 *   over a light-client hop, such as the Hub's Eureka tokens), the issuer
 *   rows' traces (which bridge or mint produced a token), and chain ids.
 * - ../zunia-chain-registry `cosmos/*.json`: the catalog's own currencies,
 *   for their symbols and `coinImageUrl` logos.
 *
 * The table is imported statically by token-identity.ts, because the MV3
 * service worker cannot run a dynamic import(). It must stay under
 * MAX_BYTES; the script fails rather than ship a larger one.
 *
 * Usage:
 *   node scripts/generate-token-registry.mjs            latest upstream commits
 *   node scripts/generate-token-registry.mjs --pinned   the SHAs already in the file
 *   node scripts/generate-token-registry.mjs --osmosis-sha <sha> --registry-sha <sha>
 *   [--zunia-registry ../zunia-chain-registry] [--cache <dir>] [--out <file>]
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const OSMOSIS_REPO = "osmosis-labs/assetlists";
const OSMOSIS_BRANCH = "main";
const OSMOSIS_FILE = "osmosis-1/generated/frontend/assetlist.json";
const REGISTRY_REPO = "cosmos/chain-registry";
const REGISTRY_BRANCH = "master";
const OSMOSIS_CHAIN_ID = "osmosis-1";

/** Size ceiling for the generated file. The plan budgets about 150 KB. */
const MAX_BYTES = 150 * 1024;

/**
 * Chains whose own IBC vouchers are listed, so a voucher held there is named
 * offline. Osmosis comes from its richer frontend list instead.
 */
const HUB_CHAINS = [
  "cosmoshub",
  "injective",
  "noble",
  "neutron",
  "axelar",
  "stride",
  "celestia",
  "dydx",
  "kava",
  "juno",
  "stargaze",
  "akash",
  "secretnetwork",
  "terra2",
  "persistence",
];

/**
 * Bridge providers as ticker tags. These are the suffixes Osmosis, Skip and
 * Keplr already use; a provider missing here is not tagged as a bridge.
 */
const PROVIDER_TAG = {
  Axelar: "axl",
  "Gravity Bridge": "grv",
  Peggy: "peggy",
  Wormhole: "wh",
  Portal: "wh",
  Picasso: "pica",
  Router: "rt",
  "Router Protocol": "rt",
  Eureka: "eureka",
  "IBC Eureka": "eureka",
  Carbon: "carbon",
  Int3face: "int3",
};

/** Source networks named in a ticker when a bridge carried a token from there. */
const NETWORK_TAG = {
  polygon: "polygon",
  avalanche: "avax",
  arbitrum: "arb",
  optimism: "op",
  base: "base",
  solana: "sol",
  binancesmartchain: "bsc",
  tron: "tron",
};

/** Hosts the logos share, so the table stores only the tail of each URL. */
const LOGO_PREFIXES = [
  "https://raw.githubusercontent.com/cosmos/chain-registry/master/",
  "https://raw.githubusercontent.com/Zunia-Lab/zunia-chain-registry/main/images/",
  "https://raw.githubusercontent.com/osmosis-labs/assetlists/main/",
];

/** Same rule as generate-chain-catalog.mjs, so "mainnet" means the same thing. */
const TESTNET_HINT = /(testnet|devnet|test-net|-test\b|localnet)/i;

/* -------------------------------------------------------------------------- *
 * Arguments and inputs
 * -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const args = {
    out: path.resolve(rootDir, "lib/token-registry.generated.ts"),
    zuniaRegistry: path.resolve(rootDir, "../zunia-chain-registry"),
    osmosisSha: null,
    registrySha: null,
    pinned: false,
    cache: null,
  };
  const valued = {
    "--osmosis-sha": (value) => (args.osmosisSha = value),
    "--registry-sha": (value) => (args.registrySha = value),
    "--zunia-registry": (value) => (args.zuniaRegistry = path.resolve(value)),
    "--cache": (value) => (args.cache = path.resolve(value)),
    "--out": (value) => (args.out = path.resolve(value)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--pinned") {
      args.pinned = true;
    } else if (valued[flag] && argv[i + 1]) {
      valued[flag](argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

/** The SHAs recorded in an earlier run, for `--pinned`. */
function pinnedShas(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  const osmosis = /osmosisAssetlists: "([0-9a-f]{40})"/.exec(text)?.[1] ?? null;
  const registry = /chainRegistry: "([0-9a-f]{40})"/.exec(text)?.[1] ?? null;
  return { osmosis, registry };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with retries and an optional on-disk cache. Pinned raw URLs never change
 * content, so caching them is safe; the branch lookups are never cached.
 */
async function fetchText(url, { cacheDir, allow404 = false, headers = {} } = {}) {
  const cacheFile = cacheDir
    ? path.join(cacheDir, crypto.createHash("sha256").update(url).digest("hex"))
    : null;
  if (cacheFile && fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile, "utf8");
    return cached === "\u0000404" ? null : cached;
  }
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
      if (response.status === 404 && allow404) {
        if (cacheFile) fs.writeFileSync(cacheFile, "\u0000404");
        return null;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const text = await response.text();
      if (cacheFile) fs.writeFileSync(cacheFile, text);
      return text;
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}

/**
 * The branch head, from the GitHub API. Two unauthenticated calls fit its rate
 * limit; GITHUB_TOKEN is used when set, for CI.
 */
async function latestSha(repo, branch) {
  const token = process.env.GITHUB_TOKEN;
  const sha = await fetchText(`https://api.github.com/repos/${repo}/commits/${branch}`, {
    headers: { accept: "application/vnd.github.sha", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const clean = (sha ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`Could not resolve ${repo}@${branch}`);
  return clean;
}

const rawUrl = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;

/** Run `fn` over `items` with at most `limit` in flight, keeping input order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* -------------------------------------------------------------------------- *
 * IBC arithmetic
 * -------------------------------------------------------------------------- */

/** ibc-go's DenomTrace.Hash(): uppercase hex sha256 of `path/base`. */
function sha256Upper(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

const CHANNEL_SEGMENT = /^channel-\d+$/;

/**
 * Split a full denom path (`transfer/channel-1279/transfer/channel-52/wei`)
 * into its hops and the base denom. Hops are `port/channel-N` pairs from the
 * left; anything after them is the base, which may itself contain slashes
 * (`factory/…/sub`, `erc20/tether/usdt`, Eureka's `transfer/08-wasm-N/0x…`).
 */
function splitFullPath(fullPath) {
  const segments = fullPath.split("/");
  const hops = [];
  let i = 0;
  while (i + 2 < segments.length && segments[i] !== "" && CHANNEL_SEGMENT.test(segments[i + 1])) {
    hops.push({ port: segments[i], channel: segments[i + 1] });
    i += 2;
  }
  return { hops, base: segments.slice(i).join("/") };
}

const hashOf = (denom) => (denom.startsWith("ibc/") ? denom.slice(4).toUpperCase() : null);

/** `erc20:0xA0…` and `peggy0x…` compare without case, like the catalog does. */
const foldDenom = (denom) => (/^(erc20:|peggy|gravity0x)/i.test(denom) ? denom.toLowerCase() : denom);

/* -------------------------------------------------------------------------- *
 * Upstream readers
 * -------------------------------------------------------------------------- */

function createRegistry(sha, cacheDir) {
  // Promises, not values, so two concurrent walks never fetch one file twice.
  const chains = new Map();
  const assets = new Map();
  const settled = { chains: new Map(), assets: new Map() };
  const load = (cache, store, name, file, pick) => {
    if (!cache.has(name)) {
      cache.set(
        name,
        fetchText(rawUrl(REGISTRY_REPO, sha, `${name}/${file}`), { cacheDir, allow404: true }).then((text) => {
          const value = text ? pick(JSON.parse(text)) : null;
          store.set(name, value);
          return value;
        }),
      );
    }
    return cache.get(name);
  };
  return {
    chain: (name) => load(chains, settled.chains, name, "chain.json", (json) => json),
    assets: (name) => load(assets, settled.assets, name, "assetlist.json", (json) => json.assets ?? []),
    chainSync: (name) => settled.chains.get(name) ?? null,
    assetsSync: (name) => settled.assets.get(name) ?? [],
    /** Every chain.json fetched so far, for chain-id lookups. */
    knownChains: () => [...settled.chains.values()].filter(Boolean),
  };
}

/**
 * Fetch what {@link classify} and {@link walkToIssuer} will read for one
 * (chain, denom): the chain, its assetlist, and the same for each chain an
 * ibc trace points back to.
 */
async function prefetchWalk(registry, name, denom, depth = 0) {
  if (!name) return;
  const [, assets] = await Promise.all([registry.chain(name), registry.assets(name)]);
  if (depth > 4) return;
  const row = (assets ?? []).find((a) => foldDenom(a.base) === foldDenom(denom));
  const last = row?.traces?.[row.traces.length - 1];
  if (last && (last.type === "ibc" || last.type === "ibc-cw20") && last.counterparty?.chain_name) {
    await prefetchWalk(registry, last.counterparty.chain_name, last.counterparty.base_denom ?? "", depth + 1);
  }
}

/** The catalog's source: Keplr-format chain files in the zunia-chain-registry checkout. */
function readZuniaRegistry(dir) {
  const cosmosDir = path.join(dir, "cosmos");
  if (!fs.existsSync(cosmosDir)) throw new Error(`No zunia-chain-registry at ${dir}`);
  let sha = "unknown";
  try {
    sha = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // Uncommitted edits would not be reproduced from the SHA alone.
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", "cosmos"], { encoding: "utf8" });
    if (dirty.trim()) sha = `${sha}-dirty`;
  } catch {
    // Not a git checkout; the header says so.
  }
  const chains = new Map();
  for (const file of fs.readdirSync(cosmosDir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(fs.readFileSync(path.join(cosmosDir, file), "utf8"));
    if (!raw.chainId) continue;
    const testnet =
      TESTNET_HINT.test(file) || TESTNET_HINT.test(raw.chainName ?? "") || TESTNET_HINT.test(raw.chainId);
    const natives = new Set(
      [raw.stakeCurrency?.coinMinimalDenom, ...(raw.feeCurrencies ?? []).map((c) => c?.coinMinimalDenom)]
        .filter(Boolean),
    );
    const first = raw.currencies?.[0]?.coinMinimalDenom;
    if (first && natives.size === 0) natives.add(first);
    chains.set(raw.chainId, {
      chainId: raw.chainId,
      chainName: raw.chainName ?? raw.chainId,
      imageDir: file.replace(/\.json$/, ""),
      prefix: raw.bech32Config?.bech32PrefixAccAddr ?? "",
      testnet,
      chainImage: raw.chainSymbolImageUrl ?? null,
      natives,
      currencies: (raw.currencies ?? []).filter((c) => c?.coinMinimalDenom && c?.coinDenom),
    });
  }
  return { sha, chains };
}

/* -------------------------------------------------------------------------- *
 * Classification: which bridge or mint produced a token
 * -------------------------------------------------------------------------- */

/**
 * The issuer row's last trace decides the tag. Port of the audit prototype
 * (token-audit/naming-rule3.ts): a bridge or ibc-bridge trace names its
 * provider; additional-mintage, liquid-stake, wrapped and legacy-mintage are
 * the issuer's own token; an ibc trace means the row is itself a voucher, so
 * the walk continues on the counterparty chain.
 */
function classify(registry, chainName, denom, depth = 0) {
  const row = registry.assetsSync(chainName).find((a) => foldDenom(a.base) === foldDenom(denom));
  const traces = row?.traces ?? [];
  const last = traces[traces.length - 1];
  if (!last || depth > 4) return { row, bridge: "", network: "" };
  if ((last.type === "ibc" || last.type === "ibc-cw20") && last.counterparty?.chain_name) {
    const deeper = classify(registry, last.counterparty.chain_name, last.counterparty.base_denom ?? "", depth + 1);
    return { row, bridge: deeper.bridge, network: deeper.network };
  }
  if (last.type === "bridge" || last.type === "ibc-bridge" || last.type === "synthetic") {
    const tag = PROVIDER_TAG[last.provider] ?? "";
    if (!tag) return { row, bridge: "", network: "" };
    const from = last.counterparty?.chain_name ?? "";
    return { row, bridge: tag, network: NETWORK_TAG[from] ?? "" };
  }
  return { row, bridge: "", network: "" };
}

/** Display exponent of a chain-registry asset: its `display` unit, else the largest. */
function registryDecimals(asset) {
  const units = asset.denom_units ?? [];
  const display = units.find((unit) => unit.denom === asset.display);
  const largest = units.reduce((best, unit) => ((unit.exponent ?? 0) > (best?.exponent ?? -1) ? unit : best), null);
  const unit = display ?? largest;
  return typeof unit?.exponent === "number" ? unit.exponent : null;
}

function registryLogo(asset) {
  return asset?.logo_URIs?.png ?? asset?.logo_URIs?.svg ?? asset?.images?.[0]?.png ?? asset?.images?.[0]?.svg ?? "";
}

/* -------------------------------------------------------------------------- *
 * Row builders
 * -------------------------------------------------------------------------- */

/**
 * The trace of an Osmosis voucher: from its IBC transfer method, else from the
 * chain-registry osmosis assetlist. `null` when neither names one.
 */
function osmosisTrace(asset, osmosisRegistryRows) {
  const method = (asset.transferMethods ?? []).find((m) => m.type === "ibc" && m.chain?.path);
  if (method) {
    return {
      fullPath: method.chain.path,
      counterpartyChainId: method.counterparty?.chainId ?? null,
      counterpartyChannelId: method.counterparty?.channelId ?? null,
    };
  }
  const row = osmosisRegistryRows.get(asset.coinMinimalDenom);
  const trace = [...(row?.traces ?? [])].reverse().find((t) => t.chain?.path);
  if (!trace) return null;
  return {
    fullPath: trace.chain.path,
    counterpartyChainId: null,
    counterpartyChainName: trace.counterparty?.chain_name ?? null,
    counterpartyChannelId: trace.counterparty?.channel_id ?? null,
  };
}

/**
 * Proof that `originDenom` is what the voucher unwinds to one hop back: the
 * rest of its path, which is a plain denom (`uusdc`) or, while it still carries
 * hops, `ibc/sha256(rest)`. Eureka hops (`transfer/08-wasm-1369/…`) are not
 * `channel-N` pairs, so they stay inside the rest and are covered by the hash.
 */
function originDenomMatches(hops, base, originDenom) {
  const rest = [...hops.slice(1).map((h) => `${h.port}/${h.channel}`), base].join("/");
  if (originDenom === rest) return true;
  const hash = hashOf(originDenom);
  return hash !== null && hash === sha256Upper(rest);
}

function symbolFor(zunia, chainId, denom, fallback) {
  const chain = zunia.chains.get(chainId);
  const hit = chain?.currencies.find((c) => foldDenom(c.coinMinimalDenom) === foldDenom(denom));
  return hit?.coinDenom ?? fallback;
}

function buildOsmosisRows(ctx, frontend) {
  const { registry, zunia, stats } = ctx;
  const osmosisRegistryRows = new Map(registry.assetsSync("osmosis").map((a) => [a.base, a]));
  const rows = [];
  for (const asset of [...frontend].sort((a, b) => (a.coinMinimalDenom < b.coinMinimalDenom ? -1 : 1))) {
    if (!asset.verified || asset.preview) continue;
    const denom = asset.coinMinimalDenom;
    let issuerName = asset.chainName;
    let originDenom = asset.sourceDenom;
    let pathHops = "";
    let base = "";
    let channelId = "";
    let counterpartyChainId = "";
    let counterpartyChannelId = "";
    if (denom.startsWith("ibc/")) {
      const trace = osmosisTrace(asset, osmosisRegistryRows);
      if (!trace) {
        stats.dropped.push(`${denom} (${asset.symbol}): no trace path`);
        continue;
      }
      if (sha256Upper(trace.fullPath) !== hashOf(denom)) {
        stats.rejected.push(`${denom} (${asset.symbol}): trace ${trace.fullPath} hashes elsewhere`);
        continue;
      }
      const { hops, base: traceBase } = splitFullPath(trace.fullPath);
      if (hops.length === 0) {
        stats.dropped.push(`${denom}: trace without hops`);
        continue;
      }
      if (issuerName === "osmosis" && hops.length === 1 && trace.counterpartyChainName) {
        // Osmosis lists a few vouchers as its own (Penumbra's UM, Namada's NAM).
        // The proven trace names the chain they came from.
        const issuer = walkToIssuer(registry, trace.counterpartyChainName, traceBase);
        if (issuer) issuerName = issuer.name;
        originDenom = traceBase;
      }
      if (!originDenomMatches(hops, traceBase, originDenom)) {
        // The listing names a source the proven trace does not unwind to. The
        // row cannot be trusted for delivery to the issuer, so it is left out.
        stats.dropped.push(`${denom} (${asset.symbol}): source ${originDenom} does not match its trace`);
        continue;
      }
      pathHops = hops.map((h) => `${h.port}/${h.channel}`).join("/");
      base = traceBase === originDenom ? "" : traceBase;
      channelId = hops[0].channel;
      const cpName = trace.counterpartyChainName;
      counterpartyChainId = trace.counterpartyChainId ?? (cpName ? registry.chainSync(cpName)?.chain_id : null) ?? "";
      counterpartyChannelId = trace.counterpartyChannelId ?? "";
    }
    const originChainId = registry.chainSync(issuerName)?.chain_id;
    if (!originChainId) {
      stats.dropped.push(`${denom} (${asset.symbol}): issuer ${issuerName} has no chain.json`);
      continue;
    }
    if (!denom.startsWith("ibc/") && (originChainId !== OSMOSIS_CHAIN_ID || originDenom !== denom)) {
      stats.dropped.push(`${denom} (${asset.symbol}): a local denom with issuer ${issuerName}`);
      continue;
    }
    const { row: issuerRow, bridge, network } = classify(registry, issuerName, originDenom);
    const symbol = asset.isAlloyed
      ? asset.symbol
      : symbolFor(zunia, originChainId, originDenom, issuerRow?.symbol ?? asset.symbol);
    rows.push({
      heldOn: OSMOSIS_CHAIN_ID,
      denom,
      origin: originChainId,
      originDenom: originDenom === denom ? "" : originDenom,
      path: pathHops,
      base,
      counterparty: counterpartyChainId && counterpartyChainId !== originChainId ? counterpartyChainId : "",
      counterpartyChannel: counterpartyChannelId,
      symbol,
      bridge: asset.isAlloyed ? "" : bridge,
      network: asset.isAlloyed ? "" : network,
      flags: (asset.isAlloyed ? 1 : 0) | 2 | (asset.unstable || asset.disabled ? 0 : 4),
      decimals: asset.decimals,
      logo: asset.logoURIs?.png ?? asset.logoURIs?.svg ?? "",
      coinGeckoId: asset.coingeckoId ?? "",
      group: asset.variantGroupKey && asset.variantGroupKey !== denom ? asset.variantGroupKey : "",
      aliases: uniqueAliases([asset.symbol, issuerRow?.symbol], symbol),
      channelId,
    });
  }
  return rows;
}

/**
 * The voucher's issuer: follow plain ibc traces until a chain's row is not
 * itself a voucher. That chain and its base are what Osmosis would call the
 * `chainName` and `sourceDenom`.
 */
function walkToIssuer(registry, chainName, denom) {
  let name = chainName;
  let base = denom;
  for (let depth = 0; depth < 5; depth += 1) {
    const row = registry.assetsSync(name).find((a) => foldDenom(a.base) === foldDenom(base));
    const last = row?.traces?.[row.traces.length - 1];
    if (!last || (last.type !== "ibc" && last.type !== "ibc-cw20") || !last.counterparty?.chain_name) {
      return { name, denom: row?.base ?? base };
    }
    name = last.counterparty.chain_name;
    base = last.counterparty.base_denom ?? "";
  }
  return null;
}

/**
 * An IBC v2 (Eureka) hop names a light client, not a channel:
 * `transfer/08-wasm-1369/0xc02a…`. Its far side is not a Cosmos chain.
 */
const CLIENT_HOP = /^([^/]+)\/(\d{2}-[a-z][a-z0-9]*-\d+)\/(.+)$/;

/**
 * A hub voucher a bridge minted over one light-client hop (the Hub's Eureka
 * ETH, USDT, WBTC). The far side is Ethereum, not a Cosmos chain, so the hub
 * is the Cosmos-side issuer, exactly as Osmosis lists these (`chainName`
 * cosmoshub, `sourceDenom` the Hub voucher). The engine's channel walk cannot
 * name them at runtime (a client id is not a channel), so without this row
 * the Hub's own Eureka tokens would read as unknown forever.
 */
function buildBridgeRow(ctx, hub, hubName, asset, trace) {
  const { registry, zunia, stats } = ctx;
  const label = `${hub.chain_id} ${asset.base} (${asset.symbol})`;
  if (sha256Upper(trace.chain.path) !== hashOf(asset.base)) {
    stats.rejected.push(`${label}: trace hashes elsewhere`);
    return null;
  }
  const hop = CLIENT_HOP.exec(trace.chain.path);
  if (!hop) {
    stats.dropped.push(`${label}: bridge path ${trace.chain.path} is not one client hop`);
    return null;
  }
  const { bridge, network } = classify(registry, hubName, asset.base);
  if (!bridge) {
    // Without its bridge tag the ticker would name the hub as the issuer.
    stats.dropped.push(`${label}: bridge provider ${trace.provider ?? "?"} has no tag`);
    return null;
  }
  const decimals = registryDecimals(asset);
  if (decimals === null) {
    stats.dropped.push(`${label}: no display exponent`);
    return null;
  }
  const symbol = symbolFor(zunia, hub.chain_id, asset.base, asset.symbol);
  return {
    heldOn: hub.chain_id,
    denom: asset.base,
    origin: hub.chain_id,
    originDenom: "",
    path: `${hop[1]}/${hop[2]}`,
    base: hop[3],
    counterparty: "",
    counterpartyChannel: "",
    symbol,
    bridge,
    network,
    flags: 2 | 4,
    decimals,
    logo: registryLogo(asset),
    coinGeckoId: asset.coingecko_id ?? "",
    group: "",
    aliases: uniqueAliases([asset.symbol], symbol),
    channelId: "",
  };
}

function buildHubRows(ctx, hubName) {
  const { registry, zunia, stats } = ctx;
  const hub = registry.chainSync(hubName);
  if (!hub?.chain_id) return [];
  const rows = [];
  const assets = [...registry.assetsSync(hubName)].sort((a, b) => (a.base < b.base ? -1 : 1));
  for (const asset of assets) {
    if (!asset.base?.startsWith("ibc/")) continue;
    const trace = [...(asset.traces ?? [])].reverse().find((t) => t.chain?.path);
    if (trace?.type === "ibc-bridge") {
      const row = buildBridgeRow(ctx, hub, hubName, asset, trace);
      if (row) rows.push(row);
      continue;
    }
    if (!trace || (trace.type !== "ibc" && trace.type !== "ibc-cw20")) continue;
    if (sha256Upper(trace.chain.path) !== hashOf(asset.base)) {
      stats.rejected.push(`${hub.chain_id} ${asset.base} (${asset.symbol}): trace hashes elsewhere`);
      continue;
    }
    // Decimals turn a typed amount into the signed one: never guess them.
    const decimals = registryDecimals(asset);
    if (decimals === null) {
      stats.dropped.push(`${hub.chain_id} ${asset.base} (${asset.symbol}): no display exponent`);
      continue;
    }
    const { hops, base } = splitFullPath(trace.chain.path);
    if (hops.length === 0) continue;
    const firstHopName = trace.counterparty?.chain_name;
    const issuer = firstHopName ? walkToIssuer(registry, firstHopName, trace.counterparty.base_denom ?? base) : null;
    const issuerChain = issuer ? registry.chainSync(issuer.name) : null;
    if (!issuer || !issuerChain?.chain_id) {
      stats.dropped.push(`${hub.chain_id} ${asset.base} (${asset.symbol}): issuer not found`);
      continue;
    }
    const originDenom = issuer.denom;
    if (!originDenomMatches(hops, base, originDenom) && !(hops.length > 1 && originDenom === base)) {
      stats.dropped.push(`${hub.chain_id} ${asset.base} (${asset.symbol}): issuer denom ${originDenom} does not match its trace`);
      continue;
    }
    const counterparty = registry.chainSync(firstHopName)?.chain_id ?? "";
    const { row: issuerRow, bridge, network } = classify(registry, issuer.name, originDenom);
    const symbol = symbolFor(zunia, issuerChain.chain_id, originDenom, issuerRow?.symbol ?? asset.symbol);
    rows.push({
      heldOn: hub.chain_id,
      denom: asset.base,
      origin: issuerChain.chain_id,
      originDenom,
      path: hops.map((h) => `${h.port}/${h.channel}`).join("/"),
      base: base === originDenom ? "" : base,
      counterparty: counterparty && counterparty !== issuerChain.chain_id ? counterparty : "",
      counterpartyChannel: trace.counterparty?.channel_id ?? "",
      symbol,
      bridge,
      network,
      flags: 2 | 4,
      decimals,
      logo: registryLogo(asset),
      coinGeckoId: asset.coingecko_id ?? "",
      group: "",
      aliases: uniqueAliases([asset.symbol, issuerRow?.symbol], symbol),
      channelId: hops[0].channel,
    });
  }
  return rows;
}

function uniqueAliases(candidates, symbol) {
  const seen = new Set([symbol.toLowerCase()]);
  const out = [];
  for (const value of candidates) {
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    out.push(value);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Catalog logos
 * -------------------------------------------------------------------------- */

/**
 * `coinImageUrl` for each mainnet catalog currency. A non-native currency whose
 * image is its chain's mark is skipped: the token slot must never show a chain
 * logo for a token that is not that chain's own coin.
 */
function catalogLogos(zunia) {
  const out = new Map();
  for (const chain of [...zunia.chains.values()].sort((a, b) => (a.chainId < b.chainId ? -1 : 1))) {
    if (chain.testnet) continue;
    const logos = new Map();
    for (const currency of chain.currencies) {
      const url = currency.coinImageUrl;
      if (!url) continue;
      const native = chain.natives.has(currency.coinMinimalDenom);
      const chainMark = url === chain.chainImage || /\/chain\.(png|svg)$/.test(url);
      if (chainMark && !native) continue;
      logos.set(currency.coinMinimalDenom, url);
    }
    if (logos.size > 0) out.set(chain.chainId, { dir: chain.imageDir, logos });
  }
  return out;
}

/**
 * Most registry images live at `<dir>/<denom>.png` (with `:` as `/`). Those
 * are stored as the denom alone and rebuilt at runtime; the rest keep a URL.
 */
function patternLogo(dir, denom) {
  return `${LOGO_PREFIXES[1]}${dir}/${denom.replace(/:/g, "/")}.png`;
}

/* -------------------------------------------------------------------------- *
 * Emit
 * -------------------------------------------------------------------------- */

/** `transfer/channel-122/transfer/channel-52` as `122/52`; other ports stay whole. */
function compressPath(fullPath) {
  if (!fullPath) return "";
  const segments = fullPath.split("/");
  const numbers = [];
  for (let i = 0; i < segments.length; i += 2) {
    const match = /^channel-(\d+)$/.exec(segments[i + 1] ?? "");
    if (segments[i] !== "transfer" || !match) return fullPath;
    numbers.push(match[1]);
  }
  return numbers.join("/");
}

function channelNumber(channel) {
  const match = /^channel-(\d+)$/.exec(channel ?? "");
  return match ? Number(match[1]) : -1;
}

function compressLogo(url) {
  for (let i = 0; i < LOGO_PREFIXES.length; i += 1) {
    if (url.startsWith(LOGO_PREFIXES[i])) return `${i}${url.slice(LOGO_PREFIXES[i].length)}`;
  }
  return url;
}

function emit({ rows, logos, chains, shas, zuniaSha }) {
  const chainIds = [...chains.keys()].sort();
  const chainIndex = new Map(chainIds.map((id, i) => [id, i]));
  const logoSet = new Set();
  for (const row of rows) if (row.logo) logoSet.add(compressLogo(row.logo));
  for (const { dir, logos: map } of logos.values()) {
    for (const [denom, url] of map) if (url !== patternLogo(dir, denom)) logoSet.add(compressLogo(url));
  }
  const logoList = [...logoSet].sort();
  const logoIndex = new Map(logoList.map((value, i) => [value, i]));
  const logoRef = (url) => (url ? logoIndex.get(compressLogo(url)) : -1);
  const groupList = [...new Set(rows.map((row) => row.group).filter(Boolean))].sort();
  const groupIndex = new Map(groupList.map((value, i) => [value, i]));

  const tuple = (row) => [
    chainIndex.get(row.heldOn),
    row.denom,
    chainIndex.get(row.origin),
    row.originDenom,
    compressPath(row.path),
    row.base,
    row.counterparty ? chainIndex.get(row.counterparty) : -1,
    channelNumber(row.counterpartyChannel),
    row.symbol,
    row.bridge,
    row.network,
    row.flags,
    row.decimals,
    logoRef(row.logo),
    row.coinGeckoId,
    row.group ? groupIndex.get(row.group) : -1,
    row.aliases.join("|"),
  ];
  const lines = [];
  lines.push("// Generated by scripts/generate-token-registry.mjs. Do not edit by hand.");
  lines.push("// Regenerate: node scripts/generate-token-registry.mjs (latest) or --pinned (same inputs).");
  lines.push("// Every ibc/ row below was kept only because sha256(path/base) equals its hash.");
  lines.push("");
  lines.push("/** Upstream commits this table was built from. */");
  lines.push("export const TOKEN_REGISTRY_SOURCES = {");
  lines.push(`  osmosisAssetlists: "${shas.osmosis}",`);
  lines.push(`  chainRegistry: "${shas.registry}",`);
  lines.push(`  zuniaChainRegistry: "${zuniaSha}",`);
  lines.push("} as const;");
  lines.push("");
  lines.push("/** URL prefixes; a logo string starting with digit i continues prefix i. */");
  lines.push(`export const TOKEN_LOGO_PREFIXES: readonly string[] = ${JSON.stringify(LOGO_PREFIXES)};`);
  lines.push("");
  lines.push("/** [chainId, display name, bech32 prefix] for every chain a row names. */");
  lines.push("export const TOKEN_CHAINS: readonly (readonly [string, string, string])[] = [");
  for (const id of chainIds) lines.push(`  ${JSON.stringify(chains.get(id))},`);
  lines.push("];");
  lines.push("");
  lines.push("/** Token logo URLs, shortened by TOKEN_LOGO_PREFIXES; rows and CATALOG_LOGOS index into them. */");
  lines.push("export const TOKEN_LOGOS: readonly string[] = [");
  for (const logo of logoList) lines.push(`  ${JSON.stringify(logo)},`);
  lines.push("];");
  lines.push("");
  lines.push("/** Osmosis variant groups (the alloy each listed variant belongs to). */");
  lines.push("export const TOKEN_GROUPS: readonly string[] = [");
  for (const group of groupList) lines.push(`  ${JSON.stringify(group)},`);
  lines.push("];");
  lines.push("");
  lines.push("/**");
  lines.push(" * One row per (holding chain, denom). Fields, in order: holding chain index,");
  lines.push(" * denom, origin chain index, origin denom (\"\" = denom), trace path (\"122/52\"");
  lines.push(" * = transfer/channel-122/transfer/channel-52; a full path when a port is not");
  lines.push(" * transfer), base (\"\" = origin denom), first-hop chain index (-1 = origin,");
  lines.push(" * or none when the first hop is a light client rather than a channel), its");
  lines.push(" * channel number (-1 unknown), issuer symbol, bridge tag, source network,");
  lines.push(" * flags (1 alloyed, 2 verified, 4 stable), decimals, logo index (-1 none),");
  lines.push(" * CoinGecko id, variant group index (-1 none), aliases joined by \"|\".");
  lines.push(" */");
  lines.push("export type TokenRowTuple = readonly [");
  lines.push("  number, string, number, string, string, string, number, number,");
  lines.push("  string, string, string, number, number, number, string, number, string,");
  lines.push("];");
  lines.push("");
  lines.push("export const TOKEN_ROWS: readonly TokenRowTuple[] = [");
  for (const row of rows) lines.push(`  ${JSON.stringify(tuple(row))},`);
  lines.push("];");
  lines.push("");
  lines.push("/**");
  lines.push(" * Catalog currency logos: [chain id, image dir, entries]. An entry is [denom]");
  lines.push(" * when the image sits at prefix 1 + `<dir>/<denom, ':' as '/'>.png`, else");
  lines.push(" * [denom, logo index].");
  lines.push(" */");
  lines.push("export const CATALOG_LOGOS: readonly (readonly [string, string, readonly (readonly [string] | readonly [string, number])[]])[] = [");
  for (const [chainId, { dir, logos: map }] of logos) {
    const entries = [...map.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([denom, url]) => (url === patternLogo(dir, denom) ? [denom] : [denom, logoRef(url)]));
    lines.push(`  [${JSON.stringify(chainId)}, ${JSON.stringify(dir)}, ${JSON.stringify(entries)}],`);
  }
  lines.push("];");
  lines.push("");
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- *
 * Main
 * -------------------------------------------------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.cache) fs.mkdirSync(args.cache, { recursive: true });
  const pinned = args.pinned ? pinnedShas(args.out) : {};
  const shas = {
    osmosis: args.osmosisSha ?? pinned.osmosis ?? (await latestSha(OSMOSIS_REPO, OSMOSIS_BRANCH)),
    registry: args.registrySha ?? pinned.registry ?? (await latestSha(REGISTRY_REPO, REGISTRY_BRANCH)),
  };
  console.log(`osmosis-labs/assetlists ${shas.osmosis}\ncosmos/chain-registry ${shas.registry}`);

  const zunia = readZuniaRegistry(args.zuniaRegistry);
  const frontendText = await fetchText(rawUrl(OSMOSIS_REPO, shas.osmosis, OSMOSIS_FILE), { cacheDir: args.cache });
  const frontend = JSON.parse(frontendText).assets ?? [];
  const registry = createRegistry(shas.registry, args.cache);

  // Fetch only what the rows will read: each verified Osmosis issuer and the
  // chains its trace points back to, the hub chains, and their vouchers'
  // issuers.
  await Promise.all([registry.chain("osmosis"), registry.assets("osmosis"), ...HUB_CHAINS.map((h) => registry.assets(h))]);
  const osmosisRegistryRows = new Map(registry.assetsSync("osmosis").map((a) => [a.base, a]));
  const walks = [];
  for (const asset of frontend) {
    if (!asset.verified || asset.preview) continue;
    walks.push([asset.chainName, asset.sourceDenom]);
    const fallback = [...(osmosisRegistryRows.get(asset.coinMinimalDenom)?.traces ?? [])].reverse().find((t) => t.chain?.path);
    if (fallback?.counterparty?.chain_name) walks.push([fallback.counterparty.chain_name, fallback.counterparty.base_denom ?? ""]);
  }
  for (const hub of HUB_CHAINS) {
    walks.push([hub, ""]);
    for (const asset of registry.assetsSync(hub)) {
      if (!asset.base?.startsWith("ibc/")) continue;
      const trace = [...(asset.traces ?? [])].reverse().find((t) => t.chain?.path);
      if (trace?.counterparty?.chain_name) walks.push([trace.counterparty.chain_name, trace.counterparty.base_denom ?? ""]);
    }
  }
  await mapLimit(walks, 12, ([name, denom]) => prefetchWalk(registry, name, denom));

  const stats = { dropped: [], rejected: [] };
  const ctx = { registry, zunia, stats };
  const rows = [...buildOsmosisRows(ctx, frontend)];
  for (const hub of HUB_CHAINS) rows.push(...buildHubRows(ctx, hub));
  rows.sort((a, b) => (a.heldOn === b.heldOn ? (a.denom < b.denom ? -1 : a.denom > b.denom ? 1 : 0) : a.heldOn < b.heldOn ? -1 : 1));

  // Chain table: catalog names where Zunia has the chain, so "on Osmosis" reads
  // the same as everywhere else in the wallet; registry names otherwise.
  const chains = new Map();
  const addChain = (chainId) => {
    if (!chainId || chains.has(chainId)) return;
    const z = zunia.chains.get(chainId);
    const reg = registry.knownChains().find((info) => info.chain_id === chainId) ?? null;
    chains.set(chainId, [chainId, z?.chainName ?? reg?.pretty_name ?? chainId, z?.prefix || reg?.bech32_prefix || ""]);
  };
  for (const row of rows) {
    addChain(row.heldOn);
    addChain(row.origin);
    addChain(row.counterparty);
  }

  const logos = catalogLogos(zunia);
  const text = emit({ rows, logos, chains, shas, zuniaSha: zunia.sha });
  const bytes = Buffer.byteLength(text);
  for (const line of stats.rejected) console.warn(`rejected: ${line}`);
  console.log(`rows ${rows.length} (dropped ${stats.dropped.length}, hash-rejected ${stats.rejected.length}), chains ${chains.size}, ${bytes} bytes`);
  if (process.env.TOKENS_VERBOSE) for (const line of stats.dropped) console.log(`dropped: ${line}`);
  if (bytes > MAX_BYTES) {
    console.error(`token table is ${bytes} bytes, over the ${MAX_BYTES}-byte budget; not written`);
    process.exit(1);
  }
  fs.writeFileSync(args.out, text);
  console.log(`wrote ${path.relative(rootDir, args.out)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
