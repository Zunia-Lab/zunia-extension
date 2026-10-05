#!/usr/bin/env node
/**
 * Builds lib/ibc-channels.generated.ts: the canonical ICS-20 transfer channel
 * between each pair of catalog mainnets, read from cosmos/chain-registry
 * `_IBC/*.json`.
 *
 * Why a table and not discovery alone: discovery walks a chain's global
 * channel list under a 100 x 3 row budget. On Osmosis the first thousand rows
 * are interchain-account channels, Noble's transfer channel to Osmosis is row
 * 464 and Injective's is row 332, so a fresh install found no channel at all
 * for those legs. And where discovery does find several channels for one pair
 * it ranks them by number, which puts Osmosis channel-109 (light client
 * Expired) ahead of channel-122, the one relayers keep alive. The registry names
 * the channel the ecosystem uses: tagged `preferred`, status `ACTIVE`.
 *
 * A row is a hint, never a proof. lib/route-plan.ts reads the channel end, the
 * counterparty and the light-client status on both chains before a plan that
 * crosses it can be signed.
 *
 * Kept: files whose two chains are mainnets in lib/chain-catalog.generated.ts
 * (registry `chain_name` matched through the catalog's `registrySlug`), whose
 * `chain_id`, when the file states one, agrees with the catalog, and channels
 * that are `transfer` on both ends and tagged preferred and ACTIVE. Both
 * directions are emitted, so a lookup never has to reverse a row.
 *
 * Pinned: the ref is resolved to a commit SHA once and every file is read at
 * that SHA. Re-running with `--ref <that sha>` reproduces the output byte for
 * byte, with no GitHub API call for the ref.
 *
 * Usage: pnpm channels:generate [--ref master|<commit sha>]
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "cosmos/chain-registry";
const CATALOG_FILE = path.join(rootDir, "lib/chain-catalog.generated.ts");
const OUT_FILE = path.join(rootDir, "lib/ibc-channels.generated.ts");
const CHANNEL_ID = /^channel-\d+$/;
const SHA = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const args = { ref: "master" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--ref" && argv[i + 1]) {
      args.ref = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function fetchJson(url, { timeoutMs = 30_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "zunia-ibc-channels", accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Catalog mainnets keyed by registry `chain_name`.
 *
 * Read from the generated catalog rather than the registry checkout because the
 * catalog is what the wallet routes over: a pair is only useful if both chains
 * are rows the planner can resolve. Each row is one line written by
 * generate-chain-catalog.mjs with JSON-encoded values, so a field is a regex
 * capture parsed back with JSON.parse, never an eval of the file.
 */
function readCatalogMainnets() {
  const text = fs.readFileSync(CATALOG_FILE, "utf8");
  const field = (line, name) => {
    const match = line.match(new RegExp(`\\b${name}: ("(?:[^"\\\\]|\\\\.)*")`));
    return match ? JSON.parse(match[1]) : undefined;
  };
  const bySlug = new Map();
  const ambiguous = new Set();
  let rows = 0;
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("{ chainId:")) continue;
    rows += 1;
    const chainId = field(line, "chainId");
    const slug = field(line, "registrySlug");
    if (field(line, "network") !== "mainnet" || !chainId || !slug) continue;
    // Two mainnets claiming one registry name would make every channel of that
    // name ambiguous. None do today; if one ever does, it gets no rows.
    if (bySlug.has(slug)) ambiguous.add(slug);
    bySlug.set(slug, chainId);
  }
  for (const slug of ambiguous) bySlug.delete(slug);
  if (rows === 0) throw new Error(`no catalog rows parsed from ${CATALOG_FILE}`);
  return { bySlug, ambiguous: [...ambiguous] };
}

async function resolveCommit(ref) {
  if (SHA.test(ref)) return ref;
  const body = await fetchJson(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`);
  if (typeof body?.sha !== "string" || !SHA.test(body.sha)) {
    throw new Error(`could not resolve ${REPO}@${ref} to a commit`);
  }
  return body.sha;
}

async function listIbcFiles(sha) {
  // `<sha>:_IBC` is a tree-ish, so one call lists the directory at the pinned commit.
  const body = await fetchJson(`https://api.github.com/repos/${REPO}/git/trees/${sha}:_IBC`);
  if (!Array.isArray(body?.tree)) throw new Error(`no _IBC tree at ${sha}`);
  if (body.truncated) throw new Error(`the _IBC listing at ${sha} is truncated`);
  return body.tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".json"))
    .map((entry) => entry.path);
}

/** The preferred, ACTIVE transfer channels of one `_IBC` file, as catalog chain ids. */
function canonicalChannels(file, data, bySlug, notes) {
  const side = (key) => {
    const chain = data?.[key];
    const chainId = bySlug.get(chain?.chain_name);
    if (!chainId) return null;
    // The registry and the catalog must mean the same chain. A file that names
    // another chain id is skipped rather than trusted.
    if (typeof chain.chain_id === "string" && chain.chain_id !== chainId) {
      notes.push(`${file}: ${chain.chain_name} is ${chain.chain_id} here but ${chainId} in the catalog`);
      return null;
    }
    return chainId;
  };
  const a = side("chain_1");
  const b = side("chain_2");
  if (!a || !b || a === b) return [];

  const kept = [];
  for (const channel of Array.isArray(data.channels) ? data.channels : []) {
    const one = channel?.chain_1;
    const two = channel?.chain_2;
    if (one?.port_id !== "transfer" || two?.port_id !== "transfer") continue;
    if (channel?.tags?.preferred !== true || channel?.tags?.status !== "ACTIVE") continue;
    if (!CHANNEL_ID.test(one.channel_id ?? "") || !CHANNEL_ID.test(two.channel_id ?? "")) {
      notes.push(`${file}: malformed channel id ${one.channel_id} / ${two.channel_id}`);
      continue;
    }
    kept.push([a, one.channel_id, b, two.channel_id]);
  }
  if (kept.length > 1) {
    notes.push(`${file}: ${kept.length} preferred ACTIVE transfer channels; all kept`);
  }
  return kept;
}

function compareRows(x, y) {
  for (let i = 0; i < 4; i += 1) {
    const order = x[i].localeCompare(y[i], "en", { numeric: true });
    if (order !== 0) return order;
  }
  return 0;
}

function serialize({ sha, files, pairs, rows }) {
  const lines = rows.map((row) => `  [${row.map((value) => JSON.stringify(value)).join(", ")}],`);
  // Nothing time-dependent goes in the header, so a re-run at the same SHA
  // writes the same bytes whether the ref was a branch name or the SHA.
  return `// Generated by scripts/generate-ibc-channels.mjs. Do not edit by hand.
// Source: https://github.com/${REPO}/tree/${sha}/_IBC
// ${files} files join two catalog mainnets; ${pairs} preferred ACTIVE transfer channel pairs, both directions.

/**
 * One direction of a canonical transfer channel:
 * \`[sourceChainId, channelId on the source, destChainId, channelId on the destination]\`.
 */
export type IbcChannelRow = readonly [string, string, string, string];

/** The chain-registry commit every row was read at. */
export const IBC_CHANNELS_COMMIT = ${JSON.stringify(sha)};

export const IBC_CHANNEL_ROWS: readonly IbcChannelRow[] = [
${lines.join("\n")}
];
`;
}

const { ref } = parseArgs(process.argv.slice(2));
const { bySlug, ambiguous } = readCatalogMainnets();
const sha = await resolveCommit(ref);
console.log(`ibc channels: ${REPO}@${sha}`);

const all = await listIbcFiles(sha);
const wanted = all.filter((file) => {
  const names = file.replace(/\.json$/, "").split("-");
  return names.length === 2 && names.every((name) => bySlug.has(name));
});

const notes = [];
const found = await mapPool(wanted, 12, async (file) => {
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/_IBC/${file}`;
  return canonicalChannels(file, await fetchJson(url), bySlug, notes);
});

const pairs = found.flat();
const seen = new Set();
const rows = [];
for (const [a, channelA, b, channelB] of pairs) {
  for (const row of [
    [a, channelA, b, channelB],
    [b, channelB, a, channelA],
  ]) {
    const key = row.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
}
rows.sort(compareRows);

fs.writeFileSync(
  OUT_FILE,
  serialize({ sha, files: wanted.length, pairs: pairs.length, rows }),
);

const bytes = fs.statSync(OUT_FILE).size;
console.log(
  `ibc channels: ${all.length} _IBC files, ${wanted.length} join two catalog mainnets, ` +
    `${pairs.length} canonical pairs -> ${rows.length} rows, ${(bytes / 1024).toFixed(1)} KB ` +
    `→ ${path.relative(rootDir, OUT_FILE)}`,
);
if (ambiguous.length > 0) {
  console.log(`  skipped registry names claimed by two mainnets: ${ambiguous.join(", ")}`);
}
for (const note of notes) console.log(`  note: ${note}`);
