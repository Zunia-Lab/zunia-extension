/**
 * Pieces shared by the three screens that move value across chains: Swap,
 * Bridge and Send's cross-send mode.
 *
 * Everything chain-facing is `@zunialab/interchain` through `lib/route-plan.ts`
 * and `lib/interchain.ts`; everything visual is `@zunialab/ui`. What is left —
 * the hooks that hold a plan while the user edits a form, and the channel
 * editor — lives here so the three screens cannot drift apart.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Button,
  Callout,
  Input,
  Spinner,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { IbcChannelOption, IbcChannelValidation } from "@zunialab/interchain";
import { normalizeChannelId } from "@zunialab/interchain";

import type { ChainBalance } from "../../../lib/balances";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { formatUnits } from "../../../lib/format";
import {
  describeInterchainError,
  setSwapContract,
  verifySwapVenue,
  type SwapVenueCheck,
} from "../../../lib/interchain";
import {
  discoverChannels,
  rememberManualChannel,
  validateChannel,
  type ManualChannel,
  type RouteHopView,
} from "../../../lib/route-plan";
import { trackTransfer, type TrackedRoute, type TrackInput } from "../../../lib/packet-tracking";
import {
  listPendingTransfers,
  removePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import { sendToBackground } from "../../../lib/popup-client";
import type { KernelStatus } from "../../../lib/kernel";
import type { ChainAccount } from "../../../lib/session";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { OverlayMenu, OverlayMenuItem } from "../components/OverlayMenu";

/* -------------------------------------------------------------------------- *
 * Assets the wallet can spend
 * -------------------------------------------------------------------------- */

/** One spendable holding: a denom on a chain, with enough to render it. */
export interface AssetOption {
  readonly key: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly chainIconUrl?: string;
  readonly denom: string;
  readonly symbol: string;
  readonly label: string;
  readonly decimals: number;
  /** Base units. `"0"` for a destination asset the wallet does not hold. */
  readonly amount: string;
  readonly iconUrl?: string;
}

/**
 * Every non-zero balance across every enabled chain, largest chains first.
 *
 * Sourced from the balance reader rather than from the catalog, so the list is
 * what the wallet can actually spend. When live reads are off the balance map
 * is empty and so is this — the screens then say why instead of offering a
 * picker that cannot be satisfied.
 */
export function spendableAssets(
  chains: readonly ChainAccountView[],
  balances: Readonly<Record<string, ChainBalance>>,
): AssetOption[] {
  const out: AssetOption[] = [];
  for (const chain of chains) {
    const balance = balances[chain.chainId];
    if (!balance) continue;
    for (const token of balance.tokens) {
      if (token.amount === "0") continue;
      out.push({
        key: `${chain.chainId}:${token.denom}`,
        chainId: chain.chainId,
        chainName: chain.entry.chainName,
        ...(chain.iconUrl ? { chainIconUrl: chain.iconUrl } : {}),
        denom: token.denom,
        symbol: token.symbol,
        label: token.displayName,
        decimals: token.decimals,
        amount: token.amount,
        ...(token.iconUrl ? { iconUrl: token.iconUrl } : {}),
      });
    }
  }
  return out;
}

/**
 * Assets a chain can receive: its own token, plus anything the wallet already
 * holds there.
 *
 * The wallet's own holdings are included because a swap into a token you
 * already have a dust amount of is the common case, and because the engine can
 * name a held `ibc/…` denom on the venue chain while it cannot name an
 * arbitrary one the user typed.
 */
export function receivableAssets(
  chains: readonly ChainAccountView[],
  balances: Readonly<Record<string, ChainBalance>>,
): AssetOption[] {
  const out: AssetOption[] = [];
  const seen = new Set<string>();
  for (const chain of chains) {
    const nativeKey = `${chain.chainId}:${chain.entry.coinMinimalDenom}`;
    seen.add(nativeKey);
    out.push({
      key: nativeKey,
      chainId: chain.chainId,
      chainName: chain.entry.chainName,
      ...(chain.iconUrl ? { chainIconUrl: chain.iconUrl } : {}),
      denom: chain.entry.coinMinimalDenom,
      symbol: chain.entry.coinDenom,
      label: chain.entry.coinDenom,
      decimals: chain.entry.coinDecimals,
      amount: balances[chain.chainId]?.available ?? "0",
      ...(chain.iconUrl ? { iconUrl: chain.iconUrl } : {}),
    });
    for (const token of balances[chain.chainId]?.tokens ?? []) {
      const key = `${chain.chainId}:${token.denom}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        chainId: chain.chainId,
        chainName: chain.entry.chainName,
        ...(chain.iconUrl ? { chainIconUrl: chain.iconUrl } : {}),
        denom: token.denom,
        symbol: token.symbol,
        label: token.displayName,
        decimals: token.decimals,
        amount: token.amount,
        ...(token.iconUrl ? { iconUrl: token.iconUrl } : {}),
      });
    }
  }
  return out;
}

/** Parse a typed decimal amount into base units. `null` when unusable. */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(input) || input === "" || input === ".") return null;
  const [whole = "0", fraction = ""] = input.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Render base units with the asset's own exponent and ticker. */
export function formatAsset(
  amount: string | null | undefined,
  decimals: number,
  symbol: string,
): string | null {
  if (amount === null || amount === undefined) return null;
  return `${formatUnits(amount, decimals)} ${symbol}`;
}

/* -------------------------------------------------------------------------- *
 * Wallet capabilities
 * -------------------------------------------------------------------------- */

/**
 * Whether this build can sign at all.
 *
 * The JS fallback kernel derives addresses correctly and cannot encode a Cosmos
 * transaction. Screens read `reason` and disable their confirm control with it
 * rather than letting the signature fail after approval.
 */
export function useKernelSigning(): {
  status: KernelStatus | null;
  loading: boolean;
  reason: string | null;
} {
  const [status, setStatus] = useState<KernelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void sendToBackground<KernelStatus>("KERNEL_STATUS")
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const reason =
    loading || !status
      ? null
      : status.canSignTransactions
        ? null
        : (status.degradedReason ??
          "The signing kernel is not loaded, so this wallet cannot build a transaction.");
  return { status, loading, reason };
}

/**
 * The crosschain-swaps contract, checked against the chain.
 *
 * The address is host configuration and the candidates shipped with it are
 * unverified, so the swap path stays off until this resolves with a venue.
 */
export function useSwapVenue(enabled: boolean): {
  check: SwapVenueCheck | null;
  loading: boolean;
  recheck: () => void;
} {
  const [token, setToken] = useState(0);
  // Identity of the check the hook should be showing. `loading` is derived from
  // it rather than stored, so no effect writes state synchronously and the
  // screen does not render twice per verification.
  const requestKey = enabled ? `venue:${token}` : "";
  const [settled, setSettled] = useState<{
    requestKey: string;
    check: SwapVenueCheck;
  } | null>(null);

  useEffect(() => {
    if (!requestKey) return;
    const controller = new AbortController();
    void verifySwapVenue({ signal: controller.signal, force: token > 0 }).then(
      (next) => {
        if (!controller.signal.aborted) setSettled({ requestKey, check: next });
      },
    );
    return () => controller.abort();
  }, [requestKey, token]);

  const recheck = useCallback(() => setToken((n) => n + 1), []);
  return {
    check: settled?.requestKey === requestKey ? settled.check : null,
    loading: Boolean(requestKey) && settled?.requestKey !== requestKey,
    recheck,
  };
}

/**
 * Derive the wallet's own address on arbitrary chains.
 *
 * Used for the ICS20 receiver on an intermediate hop and for the swap's
 * `local_recovery_addr`. Derivation needs the unlocked keyring, so it happens
 * in the background worker; this only caches the answers for the session.
 */
export function useResolveAddresses(): (
  chainIds: readonly string[],
) => Promise<Readonly<Record<string, string>>> {
  const cache = useRef(new Map<string, string>());
  return useCallback(async (chainIds: readonly string[]) => {
    const missing = chainIds.filter((id) => !cache.current.has(id));
    if (missing.length > 0) {
      try {
        const rows = await sendToBackground<ChainAccount[]>("GET_CHAIN_ACCOUNTS", {
          chainIds: missing,
        });
        for (const row of rows) {
          if (row.address) cache.current.set(row.chainId, row.address);
        }
      } catch {
        // A chain whose address will not derive stays absent, and the planner
        // then warns about the receiver rather than inventing one.
      }
    }
    const out: Record<string, string> = {};
    for (const id of chainIds) {
      const address = cache.current.get(id);
      if (address) out[id] = address;
    }
    return out;
  }, []);
}

/* -------------------------------------------------------------------------- *
 * The channel editor
 * -------------------------------------------------------------------------- */

function chainLabel(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/**
 * Pick or type the channel for one leg.
 *
 * Discovery walks every channel on the source chain and resolves each
 * connection's client, which slow or paginating LCDs regularly fail at. That is
 * not an error state: the user knows the channel, so the manual field is always
 * present and always usable, and what they type is checked on both sides before
 * it is offered as valid.
 */
function HopChannelEditor({
  fromChainId,
  toChainId,
  current,
  onPick,
  onClear,
}: {
  fromChainId: string;
  toChainId: string;
  current: string;
  onPick: (channel: ManualChannel) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const fieldId = useId();

  // Discovery runs only while the picker is open: it walks every transfer
  // channel on the source chain and resolves each connection's client, which is
  // several LCD pages and must never fire because a form re-rendered. The
  // request key carries the state, so nothing is written synchronously inside
  // an effect and the panel never renders one pass behind.
  const discoveryKey = open ? `${fromChainId}>${toChainId}` : "";
  const [discovered, setDiscovered] = useState<{
    key: string;
    rows: readonly IbcChannelOption[] | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!discoveryKey) return;
    let cancelled = false;
    void discoverChannels(fromChainId, toChainId)
      .then((rows) => {
        if (!cancelled) setDiscovered({ key: discoveryKey, rows, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDiscovered({
            key: discoveryKey,
            rows: null,
            error: describeInterchainError(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [discoveryKey, fromChainId, toChainId]);

  const fresh = discovered?.key === discoveryKey ? discovered : null;
  const options = fresh?.rows ?? null;
  const discovering = Boolean(discoveryKey) && fresh === null;
  const discoverError = fresh?.error ?? null;

  const normalized = normalizeChannelId(typed);
  const checkKey = normalized ? `${fromChainId}>${toChainId}:${normalized}` : "";
  const [checked, setChecked] = useState<{
    key: string;
    check: IbcChannelValidation | null;
  } | null>(null);

  useEffect(() => {
    if (!checkKey) return;
    const controller = new AbortController();
    // Debounced: the field is typed into character by character and the deep
    // check costs the destination chain a round trip as well.
    const handle = window.setTimeout(() => {
      void validateChannel(fromChainId, normalized, toChainId, {
        signal: controller.signal,
      })
        .then((result) => {
          if (!controller.signal.aborted) setChecked({ key: checkKey, check: result });
        })
        .catch(() => {
          if (!controller.signal.aborted) setChecked({ key: checkKey, check: null });
        });
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [checkKey, normalized, fromChainId, toChainId]);

  const check = checked?.key === checkKey ? checked.check : null;
  const checking = Boolean(checkKey) && checked?.key !== checkKey;

  function choose(channelId: string, counterpartyChannelId?: string) {
    const picked: ManualChannel = {
      fromChainId,
      toChainId,
      channelId,
      ...(counterpartyChannelId ? { counterpartyChannelId } : {}),
    };
    void rememberManualChannel(picked);
    onPick(picked);
    setOpen(false);
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "rounded-full border border-[var(--z-line)] px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-fg-muted",
          "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
          focusRing,
        )}
      >
        {open ? "Close channel picker" : "Change channel"}
      </button>

      {open ? (
        <section className="mt-2 rounded-[11px] border border-[var(--z-line)] px-2.5 py-2.5">
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">
            {chainLabel(fromChainId)} → {chainLabel(toChainId)}
          </p>

          {discovering ? (
            <p className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-fg-dim">
              <Spinner className="size-3" /> Reading channels on {chainLabel(fromChainId)}…
            </p>
          ) : null}

          {discoverError ? (
            <Callout tone="warning" className="mt-2" title="Discovery failed">
              {discoverError} You can still enter the channel below.
            </Callout>
          ) : null}

          {options && options.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1">
              {options.map((option) => (
                <li key={option.channelId}>
                  <button
                    type="button"
                    onClick={() => choose(option.channelId, option.counterpartyChannelId)}
                    aria-current={option.channelId === current}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-[9px] border px-2 py-1.5 text-left",
                      option.channelId === current
                        ? "border-[var(--z-line-strong)] bg-[var(--z-state-hover)]"
                        : "border-[var(--z-line)] hover:bg-[var(--z-state-hover)]",
                      focusRing,
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block font-mono text-[11px] text-fg">
                        {option.channelId}
                      </span>
                      <span className="block font-mono text-[9px] text-fg-dim">
                        far side {option.counterpartyChannelId || "unknown"}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-[9px] uppercase text-[var(--z-success)]">
                      open
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {options && options.length === 0 && !discovering ? (
            <p className="mt-2 text-[10.5px] text-fg-muted">
              {chainLabel(fromChainId)} reported no open transfer channel to{" "}
              {chainLabel(toChainId)}. Its endpoint may be slow or may not list every
              channel — enter the channel below if you know it.
            </p>
          ) : null}

          <Input
            id={fieldId}
            className="mt-2"
            label="Channel id"
            placeholder="channel-141"
            value={typed}
            spellCheck={false}
            autoComplete="off"
            state={!typed ? "default" : check?.ok ? "valid" : check ? "error" : "default"}
            hint={checking ? "Checking both sides…" : (check?.message ?? undefined)}
            onChange={(event) => setTyped(event.target.value)}
          />

          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="flex-1"
              disabled={!normalized}
              onClick={() =>
                choose(normalized, check?.counterpartyChannelId ?? undefined)
              }
            >
              {check?.ok ? "Use this channel" : "Use anyway"}
            </Button>
            {current ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                Reset
              </Button>
            ) : null}
          </div>
          {normalized && check && !check.ok ? (
            <p className="mt-1.5 text-[10px] text-[var(--z-warning)]">
              Nothing confirmed this channel. Sending over the wrong channel does not
              fail — it mints a token the destination chain has no record of.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** The per-hop channel controls that sit under a `RoutePreview`. */
export function HopChannelList({
  hops,
  manual,
  onPick,
  onClear,
}: {
  hops: readonly RouteHopView[];
  manual: readonly ManualChannel[];
  onPick: (channel: ManualChannel) => void;
  onClear: (fromChainId: string, toChainId: string) => void;
}) {
  const editable = hops.filter(
    (hop) => hop.kind !== "swap" && hop.counterpartyChainId !== null,
  );
  if (editable.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {editable.map((hop) => {
        const to = hop.counterpartyChainId ?? "";
        const pinned = manual.find(
          (entry) => entry.fromChainId === hop.chainId && entry.toChainId === to,
        );
        return (
          <div key={`${hop.chainId}>${to}>${hop.index}`}>
            <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">
              Hop {hop.index + 1} · {hop.channelId || "no channel"}
              {pinned ? " · you chose this" : ""}
            </p>
            <HopChannelEditor
              fromChainId={hop.chainId}
              toChainId={to}
              current={hop.channelId}
              onPick={onPick}
              onClear={() => onClear(hop.chainId, to)}
            />
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Packet tracking
 * -------------------------------------------------------------------------- */

/**
 * Poll a signed route until it lands or fails.
 *
 * Polling stops the moment the engine says the route is settled, so a finished
 * transfer does not keep hitting public endpoints while the popup is open. It
 * also stops on unmount, which for a popup is every time the user clicks away.
 */
export function useRouteTracking(
  input: TrackInput | null,
  intervalMs = 8_000,
): { route: TrackedRoute | null; error: string | null; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<{
    key: string;
    route: TrackedRoute | null;
    error: string | null;
  } | null>(null);
  const [token, setToken] = useState(0);

  const key = input ? `${input.sourceTxHash}:${input.plan.sourceChainId}:${token}` : "";
  const settled = state?.key === key && (state.route?.settled ?? false);

  useEffect(() => {
    if (!input || !key || settled) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;

    const poll = async () => {
      try {
        const next = await trackTransfer({
          ...input,
          signal: controller.signal,
          onUpdate: (partial) => {
            if (!cancelled) setState({ key, route: partial, error: null });
          },
        });
        if (cancelled) return;
        setState({ key, route: next, error: null });
        if (!next.settled) timer = window.setTimeout(() => void poll(), intervalMs);
      } catch (caught) {
        if (cancelled) return;
        // A failed read is reported as a failed read. The last known hop states
        // stay on screen and the panel says they are stale rather than live.
        setState((previous) => ({
          key,
          route: previous?.key === key ? previous.route : null,
          error: describeInterchainError(caught),
        }));
        timer = window.setTimeout(() => void poll(), intervalMs * 2);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // `input` is rebuilt on every render by its caller; `key` is its identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, settled]);

  const current = state?.key === key ? state : null;
  return {
    route: current?.route ?? null,
    error: current?.error ?? null,
    // Wholly derived: the first poll has not answered yet.
    loading: Boolean(key) && current === null,
    refresh: useCallback(() => setToken((n) => n + 1), []),
  };
}

/* -------------------------------------------------------------------------- *
 * Small shared bits
 * -------------------------------------------------------------------------- */

/**
 * Pin a different crosschain-swaps contract ahead of the shipped candidates.
 *
 * Only offered once the shipped ones have failed their on-chain check, because
 * the shipped list is the trusted path and this is the escape hatch for a
 * migrated deployment. What is entered is still verified against the chain
 * before any memo is built: this changes *what* is checked, never whether.
 */
export function SwapContractOverride({
  current,
  onSaved,
}: {
  current: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const fieldId = useId();
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn("underline underline-offset-2 text-[10.5px]", focusRing)}
      >
        {open ? "Cancel" : "Use a different contract address"}
      </button>
      {open ? (
        <div className="mt-2">
          <Input
            id={fieldId}
            label="Crosschain-swaps contract"
            placeholder="osmo1…"
            value={value}
            spellCheck={false}
            autoComplete="off"
            hint="Zunia checks this address on chain before it will build a swap."
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="flex-1"
              disabled={value.trim().length === 0}
              onClick={() => {
                void setSwapContract(value.trim()).then(() => {
                  setOpen(false);
                  onSaved();
                });
              }}
            >
              Check this address
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void setSwapContract(null).then(() => {
                  setValue("");
                  setOpen(false);
                  onSaved();
                });
              }}
            >
              Reset
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A long value inside a `KeyValueRow`, which does not truncate on its own.
 *
 * An `ibc/…` denom is 68 characters and would push the 360px popup into
 * horizontal scroll, so the value is clipped and the full text kept in the
 * title for copy and for a screen reader.
 */
export function TruncatedValue({ children }: { children: string }) {
  return (
    <span
      title={children}
      className="inline-block max-w-[180px] truncate align-bottom"
    >
      {children}
    </span>
  );
}

/** `ibc/27394FB0…41E5EB2` for a voucher, the denom itself for anything else. */
export function shortDenom(denom: string): string {
  if (!denom.startsWith("ibc/") || denom.length <= 20) return denom;
  return `ibc/${denom.slice(4, 12)}…${denom.slice(-6)}`;
}

/**
 * Routes signed earlier that are still in flight.
 *
 * A popup is destroyed when it loses focus, so without this a user who clicks
 * away loses the only view of where their funds are — and, after a failed
 * delivery, the only route to the recovery action.
 */
export function usePendingTransfers(): {
  rows: readonly PendingTransfer[];
  reload: () => void;
  forget: (txHash: string) => void;
} {
  const [token, setToken] = useState(0);
  const [settled, setSettled] = useState<{ key: number; rows: PendingTransfer[] } | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    void listPendingTransfers().then((rows) => {
      if (!cancelled) setSettled({ key: token, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [token]);
  const reload = useCallback(() => setToken((n) => n + 1), []);
  const forget = useCallback(
    (txHash: string) => {
      void removePendingTransfer(txHash).then(() => setToken((n) => n + 1));
    },
    [],
  );
  return { rows: settled?.key === token ? settled.rows : [], reload, forget };
}

/** Offer to reopen the tracker for a route signed before this popup opened. */
export function ResumeTrackingBanner({
  rows,
  onResume,
  onDismiss,
}: {
  rows: readonly PendingTransfer[];
  onResume: (row: PendingTransfer) => void;
  onDismiss: (txHash: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div
          key={row.txHash}
          className="flex items-center gap-2 rounded-[11px] border border-[var(--z-info-line)] bg-[var(--z-info-fill)] px-2.5 py-2"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] text-fg">{row.label}</span>
            <span className="block truncate font-mono text-[9px] text-fg-dim">
              still in flight · {row.txHash.slice(0, 10)}…
            </span>
          </span>
          <button
            type="button"
            onClick={() => onResume(row)}
            className={cn(
              "shrink-0 rounded-full border border-[var(--z-line)] px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-fg",
              "hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
          >
            Track
          </button>
          <button
            type="button"
            aria-label={`Stop tracking ${row.txHash}`}
            onClick={() => onDismiss(row.txHash)}
            className={cn(
              "shrink-0 rounded-full border border-[var(--z-line)] px-2 py-[3px] font-mono text-[9px] text-fg-dim",
              "hover:text-fg",
              focusRing,
            )}
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}

/** A visible, specific reason a control is off. Never rendered empty. */
export function DisabledReason({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <p className="mt-1.5 text-[10.5px] leading-snug text-fg-muted" role="status">
      {reason}
    </p>
  );
}

/* -------------------------------------------------------------------------- *
 * Asset picker
 * -------------------------------------------------------------------------- */

/**
 * One side of a swap: the asset, and the amount when the side is editable.
 *
 * At 360px the chain and the ticker cannot both be full width, so the chain
 * name sits under the ticker and the amount takes the rest of the row. The
 * picker is a real listbox button, so it is reachable and operable from the
 * keyboard.
 */
export function AssetSide({
  label,
  meta,
  asset,
  options,
  onSelect,
  amount,
  onAmountChange,
  readOnly,
  placeholder,
  emptyLabel,
}: {
  label: string;
  meta: string;
  asset: AssetOption | undefined;
  options: readonly AssetOption[];
  onSelect: (key: string) => void;
  amount: string;
  onAmountChange?: (value: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  emptyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const amountId = useId();
  return (
    <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
          {label}
        </span>
        <span className="truncate font-mono text-[9.5px] text-fg-dim">{meta}</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative min-w-0 shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={options.length === 0}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex max-w-[140px] items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-2 pr-2",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
              focusRing,
            )}
          >
            <span className="min-w-0 text-left">
              <span className="block truncate font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg">
                {asset?.symbol ?? emptyLabel}
              </span>
              <span className="block truncate font-mono text-[8.5px] text-fg-dim">
                {asset?.chainName ?? "—"}
              </span>
            </span>
          </button>
          <OverlayMenu open={open} onClose={() => setOpen(false)} className="w-[220px]">
            {options.map((option) => (
              <OverlayMenuItem
                key={option.key}
                selected={option.key === asset?.key}
                onSelect={() => {
                  onSelect(option.key);
                  setOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] text-fg">{option.label}</span>
                  <span className="block truncate font-mono text-[9px] text-fg-dim">
                    {option.chainName}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[9px] tabular-nums text-fg-dim">
                  {formatUnits(option.amount, option.decimals)}
                </span>
              </OverlayMenuItem>
            ))}
          </OverlayMenu>
        </div>
        <label className="sr-only" htmlFor={amountId}>
          {label} amount
        </label>
        <input
          id={amountId}
          inputMode="decimal"
          placeholder={placeholder ?? "0.00"}
          value={amount}
          readOnly={readOnly}
          onChange={(event) => onAmountChange?.(event.target.value)}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-right text-[22px] font-medium tracking-[-0.04em] tabular-nums outline-none",
            readOnly ? "text-fg-muted" : "text-fg",
            "placeholder:text-fg-faint",
          )}
        />
      </div>
    </section>
  );
}
