/**
 * Pieces shared by the screens that move value across chains: Swap and
 * Send's other-chain mode.
 *
 * Everything chain-facing is `@zunialab/interchain` through `lib/route-plan.ts`
 * and `lib/interchain.ts`; everything visual is `@zunialab/ui`. What is left,
 * the hooks that hold a plan while the user edits a form, and the channel
 * editor, lives here so the screens cannot drift apart.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Button,
  Callout,
  Dialog,
  DialogDescription,
  DialogTitle,
  Input,
  SectionLabel,
  SheetContent,
  Spinner,
  cn,
  focusRing,
} from "@zunialab/ui";
import type {
  ChannelDirectory,
  ExtractedPacket,
  IbcChannelOption,
  IbcChannelValidation,
} from "@zunialab/interchain";
import { TRANSFER_PORT, findRoutePaths, normalizeChannelId } from "@zunialab/interchain";

import { findCatalogEntry } from "../../../lib/chain-catalog";
/** Direct from→to only. Multi-hop via Hub is never auto-checked. */
const PAIR_ROUTE_HOPS = 1;
import {
  classifyChannelCheck,
  verdictAllowsUse,
  type ChannelVerdict,
  type ChannelVerdictKind,
} from "../../../lib/channel-verdict";
import {
  canonicalChannelIds,
  describeInterchainError,
  setSwapContract,
  verifySwapVenue,
  type SwapVenueCheck,
} from "../../../lib/interchain";
import {
  VENUE_CHAIN_ID,
  channelDirectory,
  discoverChannels,
  pathHopViews,
  rememberManualChannel,
  validateChannel,
  verifyChannelHop,
  type ManualChannel,
  type RouteHopView,
} from "../../../lib/route-plan";
import { listOsmosisAssets, type OsmosisAsset } from "../../../lib/osmosis-assets";
import {
  trackTransfer,
  walkSentPackets,
  type PacketWalk,
  type TrackedRoute,
  type TrackInput,
} from "../../../lib/packet-tracking";
import {
  listPendingTransfers,
  removePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import { sendToBackground } from "../../../lib/popup-client";
import { formatTokenAmount, type TokenAmountVariant } from "../../../lib/token-amount";
import { identityOf, type TokenIdentity } from "../../../lib/token-identity";
import { loadXcsRoutes, type XcsRouteTable } from "../../../lib/xcs-routes";
import type { KernelStatus } from "../../../lib/kernel";
import type { ChainAccount } from "../../../lib/session";

/* -------------------------------------------------------------------------- *
 * What the swap lists need from the network
 * -------------------------------------------------------------------------- */

// The lists themselves are lib/swap-assets.ts: held balances to sell, and what
// can be bought and where it is delivered, each row named by its identity.

const NO_OSMOSIS_ASSETS: readonly OsmosisAsset[] = [];

/** Osmosis's listed tokens, loaded once live reads are allowed. */
export function useOsmosisAssets(enabled: boolean): {
  assets: readonly OsmosisAsset[];
  error: string | null;
} {
  const [settled, setSettled] = useState<{
    assets: readonly OsmosisAsset[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    listOsmosisAssets({ signal: controller.signal })
      .then((assets) => {
        if (!controller.signal.aborted) setSettled({ assets, error: null });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setSettled({ assets: NO_OSMOSIS_ASSETS, error: describeInterchainError(error) });
        }
      });
    return () => controller.abort();
  }, [enabled]);
  return {
    assets: enabled ? (settled?.assets ?? NO_OSMOSIS_ASSETS) : NO_OSMOSIS_ASSETS,
    error: enabled ? (settled?.error ?? null) : null,
  };
}

/**
 * The swap contract's route table (lib/xcs-routes.ts), read once the venue is
 * verified: pass its contract address, or null while there is none. `null`
 * while it loads and when it cannot be read, which gates no To row; the live
 * route check in the planner still decides what may be signed.
 */
export function useXcsRoutes(contract: string | null): XcsRouteTable | null {
  const [settled, setSettled] = useState<{
    contract: string;
    table: XcsRouteTable | null;
  } | null>(null);
  useEffect(() => {
    if (!contract) return;
    const controller = new AbortController();
    loadXcsRoutes(contract, { signal: controller.signal })
      .then((table) => {
        if (!controller.signal.aborted) setSettled({ contract, table });
      })
      // Only a cancelled read rejects, and nothing waits on it any more.
      .catch(() => undefined);
    return () => controller.abort();
  }, [contract]);
  return contract && settled?.contract === contract ? settled.table : null;
}

/** `Date.now()`, refreshed every second while `active`. */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Parse a typed decimal amount into base units. `null` when unusable.
 *
 * `decimals` is the token's known exponent. When nobody knows it the screens
 * pass 0 and take only Max, so the field holds the exact raw balance
 * (lib/token-amount.ts `canTypeAmount`, `amountFieldText`).
 */
export function toBaseUnits(input: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(input) || input === "" || input === ".") return null;
  const [whole = "0", fraction = ""] = input.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, "0"));
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
 * The channel graph, as Send sees it
 * -------------------------------------------------------------------------- */

/** One path the wallet already knows to a destination. */
export interface ChainReach {
  readonly hops: readonly RouteHopView[];
  /** True only when every channel on the path was confirmed open. */
  readonly verified: boolean;
  /** Stable id: `from:channel>to` for each hop, joined. */
  readonly key: string;
}

function reachFromPath(path: { links: Parameters<typeof pathHopViews>[0] }): ChainReach {
  return {
    hops: pathHopViews(path.links),
    verified: path.links.every((link) => link.state === "open"),
    key: path.links
      .map((link) => `${link.sourceChainId}:${link.channelId}>${link.destChainId}`)
      .join("|"),
  };
}

/**
 * Which destinations the channel cache can already reach from `sourceChainId`.
 *
 * Local only: it reads the cache and searches it, and never calls a chain.
 * `version` changes whenever the cache is reloaded, so a plan that depends on
 * the cache can fold it into its key and replan after a discovery.
 */
export function useChannelReach(sourceChainId: string, destChainIds: readonly string[]) {
  const [directory, setDirectory] = useState<ChannelDirectory | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void channelDirectory().then((next) => {
      if (!cancelled) setDirectory(next);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const { reach, paths } = useMemo(() => {
    const best = new Map<string, ChainReach>();
    const all = new Map<string, ChainReach[]>();
    if (!directory || !sourceChainId) return { reach: best, paths: all };
    for (const destChainId of destChainIds) {
      if (destChainId === sourceChainId) continue;
      const found = findRoutePaths(sourceChainId, destChainId, directory, {
        maxHops: PAIR_ROUTE_HOPS,
        maxPaths: 8,
      }).map(reachFromPath);
      if (found.length === 0) continue;
      all.set(destChainId, found);
      best.set(destChainId, found[0]!);
    }
    return { reach: best, paths: all };
  }, [directory, sourceChainId, destChainIds]);

  return {
    reach,
    paths,
    ready: directory !== null,
    version,
    reload: useCallback(() => setVersion((n) => n + 1), []),
  };
}

/** One graph build per pair per popup session; a failed one may run again. */
const discoveryRuns = new Map<
  string,
  Promise<{ found: number; error: string | null }>
>();

function detectOnce(sourceChainId: string, destChainId: string) {
  const key = `${sourceChainId}>${destChainId}`;
  let run = discoveryRuns.get(key);
  if (!run) {
    run = (async () => {
      // The registry's canonical channel needs no walk: checking it on both
      // chains is a few reads, where walking a chain's channel list can take
      // a minute (Injective's took 84 s). Only when no canonical channel
      // passes its check is the list walked for another one.
      for (const channelId of canonicalChannelIds(sourceChainId, destChainId)) {
        if (await verifyChannelHop(sourceChainId, destChainId, channelId).catch(() => false)) {
          return { found: 1, error: null };
        }
      }
      const found = await discoverChannels(sourceChainId, destChainId);
      const directory = await channelDirectory();
      const paths = findRoutePaths(sourceChainId, destChainId, directory, {
        maxHops: PAIR_ROUTE_HOPS,
        maxPaths: 8,
      });
      const pending = new Map<string, { from: string; to: string; channelId: string }>();
      for (const path of paths) {
        for (const link of path.links) {
          if (link.state === "open") continue;
          if (link.sourceChainId !== sourceChainId || link.destChainId !== destChainId) {
            continue;
          }
          pending.set(`${link.sourceChainId}:${link.channelId}>${link.destChainId}`, {
            from: link.sourceChainId,
            to: link.destChainId,
            channelId: link.channelId,
          });
        }
      }
      await Promise.all(
        [...pending.values()].map((hop) =>
          verifyChannelHop(hop.from, hop.to, hop.channelId).catch(() => false),
        ),
      );
      return { found: found.length + paths.length + pending.size, error: null };
    })().catch((error: unknown) => ({
      found: 0,
      error: describeInterchainError(error),
    }));
    discoveryRuns.set(key, run);
    void run.then((result) => {
      if (result.error) discoveryRuns.delete(key);
    });
  }
  return run;
}

/**
 * Discover and confirm channels on the selected from→to pair only.
 */
export function useAutoDiscovery(
  sourceChainId: string,
  destChainId: string,
  run: boolean,
  onFound: () => void,
) {
  const key =
    run && sourceChainId && destChainId && sourceChainId !== destChainId
      ? `${sourceChainId}>${destChainId}`
      : "";
  const [settled, setSettled] = useState<{
    key: string;
    found: number;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    void detectOnce(sourceChainId, destChainId).then((result) => {
      if (cancelled) return;
      setSettled({ key, ...result });
      onFound();
    });
    return () => {
      cancelled = true;
    };
  }, [key, sourceChainId, destChainId, onFound]);

  const current = settled?.key === key ? settled : null;
  return {
    searching: Boolean(key) && current === null,
    found: current?.found ?? null,
    error: current?.error ?? null,
  };
}

/* -------------------------------------------------------------------------- *
 * The channel editor
 * -------------------------------------------------------------------------- */

function chainLabel(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/** ICS-024 port identifier characters and length. */
const PORT_ID = /^[a-zA-Z0-9._+\-#[\]<>]{2,128}$/;

const VERDICT_TONE: Record<ChannelVerdictKind, string> = {
  verified: "text-[var(--z-success)]",
  "open-unconfirmed": "text-[var(--z-warning)]",
  inconclusive: "text-[var(--z-warning)]",
  rejected: "text-[var(--z-danger-fg)]",
};

/** How a hop's channel reads on its row: who chose it, and what checked it. */
function hopStatus(
  hop: RouteHopView,
  pinned: ManualChannel | undefined,
): { text: string; tone: string } {
  if (pinned) {
    if (pinned.verdict === "verified") {
      return { text: "Chosen by you, confirmed on both chains", tone: VERDICT_TONE.verified };
    }
    if (pinned.verdict === "open-unconfirmed") {
      return {
        text: "Chosen by you, open here but the far side is not confirmed",
        tone: VERDICT_TONE["open-unconfirmed"],
      };
    }
    return { text: "Chosen by you, not confirmed on chain", tone: VERDICT_TONE.inconclusive };
  }
  if (!hop.channelId) return { text: "No channel found yet", tone: VERDICT_TONE.inconclusive };
  if (hop.channelVerified) return { text: "Found on chain, open", tone: VERDICT_TONE.verified };
  if (hop.channelSource === "seed") {
    return { text: "Known channel, not checked yet", tone: "text-fg-dim" };
  }
  return { text: "Not checked", tone: "text-fg-dim" };
}

/**
 * Pick or type the channel for one leg, in a sheet over the form.
 *
 * Discovery walks every channel on the source chain and resolves each
 * connection's client, which slow or paginating LCDs regularly fail at. That
 * is not an error state: the user may know the channel, so the manual fields
 * are always there. What they type is checked on both chains, a definite "no"
 * blocks it, and a chain that could not be asked is said out loud.
 */
function ChannelSheet({
  open,
  onClose,
  fromChainId,
  toChainId,
  pinned,
  onPick,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  fromChainId: string;
  toChainId: string;
  pinned: ManualChannel | undefined;
  onPick: (channel: ManualChannel) => void;
  onClear: () => void;
}) {
  const descriptionId = useId();
  const [port, setPort] = useState(pinned?.port ?? TRANSFER_PORT);
  const [typed, setTyped] = useState("");

  // Every opening starts from the channel in use, not from the last draft.
  const [openedFor, setOpenedFor] = useState(open);
  if (openedFor !== open) {
    setOpenedFor(open);
    if (open) {
      setPort(pinned?.port ?? TRANSFER_PORT);
      setTyped("");
    }
  }

  // Discovery runs only while the sheet is open: it walks every transfer
  // channel on the source chain, which is several LCD pages and must never
  // fire because a form re-rendered.
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
          setDiscovered({ key: discoveryKey, rows: null, error: describeInterchainError(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [discoveryKey, fromChainId, toChainId]);

  const fresh = discovered?.key === discoveryKey ? discovered : null;
  const options = fresh?.rows ?? null;
  const discovering = Boolean(discoveryKey) && fresh === null;

  const portId = port.trim() || TRANSFER_PORT;
  const portValid = PORT_ID.test(portId);
  const normalized = normalizeChannelId(typed);
  const checkKey =
    open && normalized && portValid ? `${fromChainId}>${toChainId}:${portId}/${normalized}` : "";
  const [checked, setChecked] = useState<{
    key: string;
    check: IbcChannelValidation | null;
  } | null>(null);

  useEffect(() => {
    if (!checkKey) return;
    const controller = new AbortController();
    // Debounced: the field is typed into character by character, and the
    // deep check costs the destination chain a round trip as well.
    const handle = window.setTimeout(() => {
      void validateChannel(fromChainId, normalized, toChainId, {
        portId,
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
  }, [checkKey, normalized, portId, fromChainId, toChainId]);

  const settledCheck = checked?.key === checkKey ? checked : null;
  const checking = Boolean(checkKey) && settledCheck === null;
  const verdict: ChannelVerdict | null = settledCheck
    ? settledCheck.check
      ? classifyChannelCheck(settledCheck.check, toChainId)
      : {
          kind: "inconclusive",
          note: "The check did not finish. Nothing confirmed this channel.",
        }
    : null;

  function choose(channel: {
    channelId: string;
    counterpartyChannelId?: string;
    port: string;
    verdict: ChannelVerdictKind;
  }) {
    const picked: ManualChannel = {
      fromChainId,
      toChainId,
      channelId: channel.channelId,
      ...(channel.counterpartyChannelId
        ? { counterpartyChannelId: channel.counterpartyChannelId }
        : {}),
      ...(channel.port !== TRANSFER_PORT ? { port: channel.port } : {}),
      verdict: channel.verdict,
    };
    onClose();
    // Written to the cache first, so a caller that reloads the cache on the
    // pick finds the channel there.
    void rememberManualChannel(picked)
      .catch(() => undefined)
      .then(() => onPick(picked));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={descriptionId}
        className="flex max-h-[88vh] flex-col overflow-hidden px-0 pb-0 pt-3"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          <DialogTitle className="text-[15px]">
            Channel to {chainLabel(toChainId)}
          </DialogTitle>
          <DialogDescription id={descriptionId} className="mt-1 text-[11px]">
            Zunia picks the channel from {chainLabel(fromChainId)} on its own. Enter one
            only if you know it: it is checked on both chains before you can use it.
          </DialogDescription>

          {discovering ? (
            <p className="mt-3 flex items-center gap-1.5 font-mono text-[10px] text-fg-dim">
              <Spinner className="size-3" /> Reading channels on {chainLabel(fromChainId)}…
            </p>
          ) : null}

          {fresh?.error ? (
            <Callout tone="warning" className="mt-3" title="Could not list channels">
              {fresh.error} You can still enter the channel below.
            </Callout>
          ) : null}

          {options && options.length > 0 ? (
            <section className="mt-3">
              <SectionLabel>Open channels found</SectionLabel>
              <ul className="mt-1.5 flex flex-col gap-1">
                {options.map((option) => {
                  const inUse =
                    pinned?.channelId === option.channelId &&
                    (pinned.port ?? TRANSFER_PORT) === option.portId;
                  return (
                    <li key={`${option.portId}/${option.channelId}`}>
                      <button
                        type="button"
                        aria-current={inUse || undefined}
                        onClick={() =>
                          choose({
                            channelId: option.channelId,
                            counterpartyChannelId: option.counterpartyChannelId,
                            port: option.portId || TRANSFER_PORT,
                            // Discovery keeps only open channels whose client
                            // targets the destination, which is what "verified"
                            // means here.
                            verdict: "verified",
                          })
                        }
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-[9px] border px-2.5 py-2 text-left",
                          inUse
                            ? "border-[var(--z-line-strong)] bg-[var(--z-state-selected)]"
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
                  );
                })}
              </ul>
            </section>
          ) : null}

          {options && options.length === 0 && !discovering ? (
            <p className="mt-3 text-[10.5px] leading-snug text-fg-muted">
              {chainLabel(fromChainId)} reported no open transfer channel to{" "}
              {chainLabel(toChainId)}. Its endpoint may be slow or may not list every
              channel, so enter the channel below if you know it.
            </p>
          ) : null}

          <section className="mt-3">
            <SectionLabel>Enter by hand</SectionLabel>
            <div className="mt-1.5 grid grid-cols-[92px_minmax(0,1fr)] gap-2">
              <Input
                label="Port"
                placeholder={TRANSFER_PORT}
                value={port}
                spellCheck={false}
                autoComplete="off"
                state={portValid ? "default" : "error"}
                hint={portValid ? undefined : "Not a port id"}
                onChange={(event) => setPort(event.target.value)}
              />
              <Input
                label="Channel"
                placeholder="channel-141"
                value={typed}
                spellCheck={false}
                autoComplete="off"
                state={
                  !verdict
                    ? "default"
                    : verdict.kind === "verified"
                      ? "valid"
                      : verdict.kind === "rejected"
                        ? "error"
                        : "default"
                }
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <p
              aria-live="polite"
              className={cn(
                "mt-1.5 min-h-[14px] text-[10.5px] leading-snug",
                verdict ? VERDICT_TONE[verdict.kind] : "text-fg-dim",
              )}
            >
              {checking
                ? "Checking both chains…"
                : verdict
                  ? verdict.note
                  : normalized
                    ? ""
                    : "For example channel-141, or just 141."}
            </p>
            {verdict && verdict.kind !== "verified" && verdict.kind !== "rejected" ? (
              <p className="mt-1 text-[10px] leading-snug text-[var(--z-warning)]">
                A channel that leads to another chain does not fail: the tokens land
                there instead of on {chainLabel(toChainId)}. Only continue if you are sure.
              </p>
            ) : null}
          </section>
        </div>

        <div className="flex gap-2 border-t border-[var(--z-line)] px-4 py-3">
          {pinned ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                onClear();
                onClose();
              }}
            >
              Back to automatic
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            className="flex-1"
            disabled={!normalized || !portValid || checking || !verdict || !verdictAllowsUse(verdict)}
            onClick={() => {
              if (!verdict) return;
              choose({
                channelId: normalized,
                counterpartyChannelId: verdict.counterpartyChannelId,
                port: portId,
                verdict: verdict.kind,
              });
            }}
          >
            {verdict?.kind === "inconclusive" || verdict?.kind === "open-unconfirmed"
              ? "Use without confirmation"
              : "Use this channel"}
          </Button>
        </div>
      </SheetContent>
    </Dialog>
  );
}

function HopChannelRow({
  hop,
  pinned,
  numbered,
  onPick,
  onClear,
}: {
  hop: RouteHopView;
  pinned: ManualChannel | undefined;
  numbered: boolean;
  onPick: (channel: ManualChannel) => void;
  onClear: (fromChainId: string, toChainId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const to = hop.counterpartyChainId ?? "";
  const channelId = pinned?.channelId ?? hop.channelId;
  const status = hopStatus(hop, pinned);
  return (
    <li className="rounded-[11px] border border-[var(--z-line)] px-2.5 py-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[10.5px] text-fg">
            {numbered ? `Hop ${hop.index + 1}: ` : ""}
            {channelId || "no channel"} to {to}{" "}
            <span className="text-fg-dim">({pinned ? "manual" : "auto"})</span>
          </span>
          <span className={cn("mt-0.5 block text-[9.5px] leading-snug", status.tone)}>
            {status.text}
          </span>
        </span>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Modify the channel from ${chainLabel(hop.chainId)} to ${chainLabel(to)}`}
          onClick={() => setEditing(true)}
          className={cn(
            "shrink-0 rounded-full border border-[var(--z-line)] px-2 py-[3px] font-mono text-[9px] uppercase tracking-[0.1em] text-fg-muted",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
            focusRing,
          )}
        >
          Modify
        </button>
      </div>
      {pinned ? (
        <button
          type="button"
          onClick={() => onClear(hop.chainId, to)}
          className={cn(
            "mt-1.5 text-[10px] text-fg-muted underline underline-offset-2 hover:text-fg",
            focusRing,
          )}
        >
          Back to automatic
        </button>
      ) : null}
      <ChannelSheet
        open={editing}
        onClose={() => setEditing(false)}
        fromChainId={hop.chainId}
        toChainId={to}
        pinned={pinned}
        onPick={onPick}
        onClear={() => onClear(hop.chainId, to)}
      />
    </li>
  );
}

/**
 * One row per leg of the route: the channel, whether Zunia picked it or the
 * user did, what checked it, and the Modify control that opens the editor.
 */
function routeChoiceTitle(option: ChainReach): string {
  if (option.hops.length === 1) {
    const hop = option.hops[0]!;
    return `Direct · ${hop.channelId}`;
  }
  const via = option.hops
    .slice(0, -1)
    .map((hop) => hop.counterpartyChainName ?? hop.counterpartyChainId ?? "…")
    .join(", ");
  return `${option.hops.length} hops via ${via}`;
}

function routeChoiceMeta(option: ChainReach): string {
  const channels = option.hops.map((hop) => hop.channelId || "?").join(" → ");
  return option.verified ? `${channels} · checked open` : `${channels} · checking`;
}

/** When more than one path exists, the user picks the one to plan and sign. */
export function RouteChoiceList({
  options,
  selectedKey,
  onSelect,
}: {
  options: readonly ChainReach[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  if (options.length <= 1) return null;
  return (
    <section>
      <SectionLabel>Choose a route</SectionLabel>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {options.map((option) => {
          const selected = option.key === selectedKey;
          return (
            <li key={option.key}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(option.key)}
                className={cn(
                  "flex w-full min-w-0 flex-col items-start rounded-[12px] border px-3 py-2 text-left",
                  "transition-colors duration-[var(--z-duration-base)]",
                  selected
                    ? "border-accent bg-[var(--z-state-selected)]"
                    : "border-[var(--z-line)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)]",
                  focusRing,
                )}
              >
                <span className="text-[12.5px] font-medium text-fg">
                  {routeChoiceTitle(option)}
                </span>
                <span className="mt-0.5 break-all font-mono text-[9.5px] text-fg-dim">
                  {routeChoiceMeta(option)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
    <ul className="flex flex-col gap-1.5">
      {editable.map((hop) => {
        const to = hop.counterpartyChainId ?? "";
        const pinned = manual.find(
          (entry) => entry.fromChainId === hop.chainId && entry.toChainId === to,
        );
        return (
          <HopChannelRow
            key={`${hop.chainId}>${to}>${hop.index}`}
            hop={hop}
            pinned={pinned}
            numbered={editable.length > 1}
            onPick={onPick}
            onClear={onClear}
          />
        );
      })}
    </ul>
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

/**
 * Poll the packets a past transaction sent until none of them can change.
 * The history counterpart of {@link useRouteTracking}, for a transaction the
 * wallet kept no plan for.
 */
export function usePacketWalk(
  input: { chainId: string; txHash: string; packets: readonly ExtractedPacket[] } | null,
  intervalMs = 8_000,
): { walk: PacketWalk | null; error: string | null; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<{
    key: string;
    walk: PacketWalk | null;
    error: string | null;
  } | null>(null);
  const [token, setToken] = useState(0);

  const key =
    input && input.packets.length > 0
      ? `${input.chainId}:${input.txHash}:${input.packets.length}:${token}`
      : "";
  const settled = state?.key === key && (state.walk?.settled ?? false);

  useEffect(() => {
    if (!input || !key || settled) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;

    const poll = async () => {
      try {
        const walk = await walkSentPackets({ ...input, signal: controller.signal });
        if (cancelled) return;
        setState({ key, walk, error: null });
        if (!walk.settled) timer = window.setTimeout(() => void poll(), intervalMs);
      } catch (caught) {
        if (cancelled) return;
        setState((previous) => ({
          key,
          walk: previous?.key === key ? previous.walk : null,
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
    walk: current?.walk ?? null,
    error: current?.error ?? null,
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

export { shortDenom } from "../../../lib/format";

/**
 * Routes signed earlier that are still in flight.
 *
 * A popup is destroyed when it loses focus, so without this a user who clicks
 * away loses the only view of where their funds are and, after a failed
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

/**
 * An amount with the ticker the token wears on every other line of these
 * screens: `12.34 USDC.n`, or `12340000 base units IBC·498A` for a token
 * nobody can name, as on its pill and picker row. Never a bare denom as the
 * token's name; the exact denom has its own line where it matters.
 */
export function tickerAmount(
  amount: string | bigint,
  identity: TokenIdentity,
  variant: TokenAmountVariant,
): string {
  return `${formatTokenAmount(amount, identity, variant)} ${identity.ticker}`;
}

/**
 * A swap's one-line label, as its pending record keeps it for Activity, the
 * resume banner and the OS notification: `10 OSMO (Osmosis) → USDC.axl
 * (Axelar)`. Each side names its chain: the ticker says what a token is, and
 * never where it is.
 */
export function swapRouteLabel(
  amountBaseUnits: string | bigint,
  from: TokenIdentity,
  to: Pick<TokenIdentity, "ticker" | "heldOnChainName">,
): string {
  const sold = tickerAmount(amountBaseUnits, from, "history");
  return `${sold} (${from.heldOnChainName}) → ${to.ticker} (${to.heldOnChainName})`;
}

/**
 * The token a swap's plan delivers, named for the chain it lands on, or null
 * when the plan cannot name it.
 *
 * A swap plan's `outputDenom` is the venue's own denom (the memo's
 * `output_denom`) whenever the delivered form could not be computed, which is
 * the case for every Osmosis voucher sent home: ATOM delivered on the Hub is
 * planned as `ibc/2739…`, USDC.axl delivered on Axelar as `ibc/D189…`. Those
 * denoms name nothing on the destination (they would read `IBC·2739`), so they
 * are read on the venue: the ticker says what the asset is and never where,
 * and the chain is the destination.
 */
function swapDelivered(
  plan: Pick<PendingTransfer["plan"], "destChainId" | "outputDenom">,
): Pick<TokenIdentity, "ticker" | "heldOnChainName"> | null {
  const there = identityOf(plan.destChainId, plan.outputDenom);
  if (there.provenance !== "unknown") return there;
  if (plan.destChainId === VENUE_CHAIN_ID) return null;
  const bought = identityOf(VENUE_CHAIN_ID, plan.outputDenom);
  if (bought.provenance === "unknown") return null;
  return {
    ticker: bought.ticker,
    heldOnChainName: findCatalogEntry(plan.destChainId)?.chainName ?? plan.destChainId,
  };
}

/** A transfer's label, the same way: `10 USDC.n → Noble`. */
export function transferRouteLabel(
  amountBaseUnits: string | bigint,
  token: TokenIdentity,
  destChainName: string,
): string {
  return `${tickerAmount(amountBaseUnits, token, "history")} → ${destChainName}`;
}

/**
 * What the resume banner says about a pending route: named from its plan by
 * identity, not by the label stored when it was signed, so a record kept from
 * before (0.1.2 called Noble USDC "USDC.axl") reads right too. A swap whose
 * plan cannot name what it delivers keeps the words it was saved with, which
 * Activity and the notification show as well, rather than a hash ticker.
 */
export function pendingRouteLabel(
  row: Pick<PendingTransfer, "kind" | "plan" | "amountBaseUnits" | "label">,
): string {
  const { plan } = row;
  // Stored records are checked for their hops only; one without these
  // fields keeps the words it was saved with.
  const named = [plan.sourceChainId, plan.inputDenom, plan.destChainId, plan.outputDenom];
  if (!named.every((field) => typeof field === "string" && field.length > 0)) return row.label;
  const sent = identityOf(plan.sourceChainId, plan.inputDenom);
  if (row.kind === "swap") {
    const delivered = swapDelivered(plan);
    return delivered ? swapRouteLabel(row.amountBaseUnits, sent, delivered) : row.label;
  }
  return transferRouteLabel(
    row.amountBaseUnits,
    sent,
    findCatalogEntry(plan.destChainId)?.chainName ?? plan.destChainId,
  );
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
            {/* Wrapped, never cut: a ticker's suffix and the chains are the point. */}
            <span className="block text-[11px] leading-snug text-fg [overflow-wrap:anywhere]">
              {pendingRouteLabel(row)}
            </span>
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
