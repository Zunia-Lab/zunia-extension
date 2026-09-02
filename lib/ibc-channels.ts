/**
 * IBC channel discovery / validation against a chain's public LCD.
 *
 * Finds open `transfer` channels whose connection client targets a destination
 * chain id. Used by Cross-send so the user does not have to guess channel-N.
 */

import { findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission } from "./balances";
import { getSettings } from "./settings";

const REQUEST_TIMEOUT_MS = 9_000;
const CHANNEL_PAGE = 100;
const MAX_PAGES = 3;

export type IbcChannelState = "open" | "closed" | "init" | "tryopen" | "unknown";

export interface IbcChannelOption {
  channelId: string;
  portId: string;
  counterpartyChannelId: string;
  counterpartyPortId: string;
  connectionId: string;
  counterpartyChainId: string | null;
  state: IbcChannelState;
}

export interface IbcChannelCheck {
  ok: boolean;
  state: IbcChannelState;
  channelId: string;
  portId: string;
  counterpartyChannelId?: string;
  counterpartyChainId?: string | null;
  message: string;
}

function restOf(chainId: string): string | null {
  const rest = findCatalogEntry(chainId)?.rest?.replace(/\/$/, "");
  return rest || null;
}

async function readsAllowed(): Promise<boolean> {
  const settings = await getSettings();
  return settings.liveBalances && (await hasLiveBalancePermission());
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeChannelId(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return "";
  if (/^channel-\d+$/.test(value)) return value;
  if (/^\d+$/.test(value)) return `channel-${value}`;
  return value;
}

function mapState(raw: unknown): IbcChannelState {
  const s = String(raw ?? "").toUpperCase();
  if (s.includes("OPEN")) return "open";
  if (s.includes("CLOSED")) return "closed";
  if (s.includes("INIT")) return "init";
  if (s.includes("TRY")) return "tryopen";
  return "unknown";
}

function clientChainId(clientState: unknown): string | null {
  if (!clientState || typeof clientState !== "object") return null;
  const row = clientState as Record<string, unknown>;
  // Tendermint: { "@type": "...", chain_id: "…" } sometimes nested under client_state
  const nested =
    row.client_state && typeof row.client_state === "object"
      ? (row.client_state as Record<string, unknown>)
      : row;
  const id = nested.chain_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function resolveConnectionChainId(
  rest: string,
  connectionId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(connectionId)) return cache.get(connectionId) ?? null;
  try {
    const conn = (await getJson(
      `${rest}/ibc/core/connection/v1/connections/${encodeURIComponent(connectionId)}`,
    )) as {
      connection?: { client_id?: string };
      client_id?: string;
    };
    const clientId =
      conn.connection?.client_id ?? conn.client_id ?? null;
    if (!clientId) {
      cache.set(connectionId, null);
      return null;
    }
    const state = await getJson(
      `${rest}/ibc/core/client/v1/client_states/${encodeURIComponent(clientId)}`,
    );
    const chainId = clientChainId(state);
    cache.set(connectionId, chainId);
    return chainId;
  } catch {
    cache.set(connectionId, null);
    return null;
  }
}

type RawChannel = {
  channel_id?: string;
  port_id?: string;
  state?: string;
  connection_hops?: string[];
  counterparty?: { channel_id?: string; port_id?: string };
};

async function listTransferChannels(rest: string): Promise<RawChannel[]> {
  const out: RawChannel[] = [];
  let key: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      "pagination.limit": String(CHANNEL_PAGE),
    });
    if (key) params.set("pagination.key", key);
    const body = (await getJson(
      `${rest}/ibc/core/channel/v1/channels?${params}`,
    )) as {
      channels?: RawChannel[];
      pagination?: { next_key?: string | null };
    };
    const rows = body.channels ?? [];
    for (const row of rows) {
      if ((row.port_id ?? "transfer") !== "transfer") continue;
      out.push(row);
    }
    const next = body.pagination?.next_key;
    if (!next) break;
    key = next;
  }
  return out;
}

/**
 * Open transfer channels on `sourceChainId` that connect to `destChainId`.
 * Empty when live reads are off or the LCD has no match.
 */
export async function findIbcChannels(
  sourceChainId: string,
  destChainId: string,
): Promise<IbcChannelOption[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(sourceChainId);
  if (!rest || !destChainId || sourceChainId === destChainId) return [];

  const raw = await listTransferChannels(rest);
  const cache = new Map<string, string | null>();
  const matches: IbcChannelOption[] = [];

  for (const row of raw) {
    const channelId = row.channel_id;
    if (!channelId) continue;
    const state = mapState(row.state);
    if (state !== "open") continue;
    const connectionId = row.connection_hops?.[0];
    if (!connectionId) continue;
    const counterpartyChainId = await resolveConnectionChainId(
      rest,
      connectionId,
      cache,
    );
    if (counterpartyChainId !== destChainId) continue;
    matches.push({
      channelId,
      portId: row.port_id ?? "transfer",
      counterpartyChannelId: row.counterparty?.channel_id ?? "",
      counterpartyPortId: row.counterparty?.port_id ?? "transfer",
      connectionId,
      counterpartyChainId,
      state,
    });
  }

  return matches.sort((a, b) =>
    a.channelId.localeCompare(b.channelId, undefined, { numeric: true }),
  );
}

/** Check a single channel id on the source LCD (manual entry). */
export async function validateIbcChannel(
  sourceChainId: string,
  channelRaw: string,
  destChainId?: string,
): Promise<IbcChannelCheck> {
  const channelId = normalizeChannelId(channelRaw);
  const portId = "transfer";
  if (!channelId) {
    return {
      ok: false,
      state: "unknown",
      channelId: "",
      portId,
      message: "Enter a channel id (e.g. channel-141)",
    };
  }
  if (!(await readsAllowed())) {
    return {
      ok: false,
      state: "unknown",
      channelId,
      portId,
      message: "Turn on live balances to check channels",
    };
  }
  const rest = restOf(sourceChainId);
  if (!rest) {
    return {
      ok: false,
      state: "unknown",
      channelId,
      portId,
      message: "No REST endpoint for this chain",
    };
  }

  try {
    const body = (await getJson(
      `${rest}/ibc/core/channel/v1/channels/${encodeURIComponent(channelId)}/ports/${portId}`,
    )) as {
      channel?: RawChannel;
    };
    const row = body.channel;
    if (!row) {
      return {
        ok: false,
        state: "unknown",
        channelId,
        portId,
        message: "Channel not found on this chain",
      };
    }
    const state = mapState(row.state);
    const connectionId = row.connection_hops?.[0];
    let counterpartyChainId: string | null = null;
    if (connectionId) {
      counterpartyChainId = await resolveConnectionChainId(
        rest,
        connectionId,
        new Map(),
      );
    }
    if (state !== "open") {
      return {
        ok: false,
        state,
        channelId,
        portId,
        counterpartyChannelId: row.counterparty?.channel_id,
        counterpartyChainId,
        message: `Channel is ${state}, not open`,
      };
    }
    if (destChainId && counterpartyChainId && counterpartyChainId !== destChainId) {
      return {
        ok: false,
        state,
        channelId,
        portId,
        counterpartyChannelId: row.counterparty?.channel_id,
        counterpartyChainId,
        message: `Open, but connects to ${counterpartyChainId}`,
      };
    }
    return {
      ok: true,
      state,
      channelId,
      portId,
      counterpartyChannelId: row.counterparty?.channel_id,
      counterpartyChainId,
      message: counterpartyChainId
        ? `Open · ${counterpartyChainId}`
        : "Open and ready",
    };
  } catch {
    return {
      ok: false,
      state: "unknown",
      channelId,
      portId,
      message: "Could not reach the chain to verify this channel",
    };
  }
}
