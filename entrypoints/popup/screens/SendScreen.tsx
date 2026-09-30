/**
 * Send, on the same chain or to another one. The old Bridge screen routes here.
 *
 * Same-chain send is a `MsgSend` on the wallet's long-standing amino path.
 * Other-chain send is IBC, and it is planned by `@zunialab/interchain`: the engine
 * decides whether a wrapped token unwinds along its own trace or wraps again,
 * finds a path when no direct channel exists and composes the
 * packet-forward-middleware memo for it, and reports which channels anyone has
 * actually verified. The hand-rolled channel discovery this screen used to call
 * (`lib/ibc-channels.ts`) is gone.
 *
 * The channel is picked automatically: the cache is searched first, and when
 * it has no confirmed direct channel to the destination, discovery runs on its
 * own. The user can still override any hop with a port and channel of their
 * own, which is checked on both chains; a definite "no" blocks it, and a chain
 * that could not be asked is stated on the review screen, not hidden.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  TokenLogo,
  Callout,
  Input,
  KeyValueRow,
  PacketTracker,
  Pill,
  RoutePreview,
  ScreenScaffold,
  Segmented,
  SectionLabel,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { BuiltMsg } from "@zunialab/interchain";

import type { ChainBalance, TokenBalance } from "../../../lib/balances";
import { chainTicker, feeTicker } from "../../../lib/chain-catalog";
import type { AddressBookEntry } from "../../../lib/address-book";
import { explorerTxUrl } from "../../../config/interchain";
import { estimateFee, msgSend } from "../../../lib/amino-tx";
import { resolveTxMemo } from "../../../lib/tx-memo";
import {
  NO_VALUE,
  decimalText,
  formatUnits,
  formatUnitsExact,
  isBech32,
  prefixOf,
} from "../../../lib/format";
import { maxSendable, reservedFeeUnits } from "../../../lib/fee-prefs";
import { sendToBackground } from "../../../lib/popup-client";
import {
  buildTransferMsgFromPlan,
  planTransfer,
  type ManualChannel,
  type RouteHopView,
  type RoutePlanView,
  type TransferPlanResult,
} from "../../../lib/route-plan";
import { PACKET_TIMEOUT_MINUTES } from "../../../config/interchain";
import {
  removePendingTransfer,
  savePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import { routeOutcome } from "../../../lib/packet-tracking";
import type { TxPreview } from "../../../lib/tx-kernel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useTxDetail } from "../hooks/useChainQuery";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { ChainSheet, PickerTrigger } from "../components/ChainSheet";
import { PickerSheet, type PickerItem } from "../components/PickerSheet";
import { usePickerMemory } from "../hooks/usePickerMemory";
import {
  AddressBookPicker,
  AddressFieldActions,
  ContactChips,
  QrScanOverlay,
} from "../components/AddressFieldExtras";
import {
  DisabledReason,
  HopChannelList,
  ResumeTrackingBanner,
  RouteChoiceList,
  TruncatedValue,
  toBaseUnits,
  useAutoDiscovery,
  useChannelReach,
  useKernelSigning,
  usePendingTransfers,
  useResolveAddresses,
  useRouteTracking,
  type ChainReach,
} from "./interchain-ui";
import { SaveContactPrompt } from "../components/SaveContactPrompt";
import { fieldFocusWithin } from "../components/field-focus";
import { IconCheck, IconCopy, IconSend } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";

const PERCENTS = [25, 50, 75, 100] as const;
export type SendMode = "send" | "cross";
type SendPhase = "form" | "confirm" | "sent";

/** The chain's own token, so cross-send has something to select before balances load. */
function nativeToken(chain: ChainAccountView, balance?: ChainBalance): TokenBalance {
  return {
    denom: chain.entry.coinMinimalDenom,
    amount: balance?.available ?? "0",
    kind: "native",
    symbol: chainTicker(chain.entry),
    displayName: chainTicker(chain.entry),
    decimals: chain.entry.coinDecimals,
    ...(chain.iconUrl ? { iconUrl: chain.iconUrl } : {}),
  };
}

/** Every token held on a chain: native first, then IBC, factory, and others. */
function tokensOn(chain: ChainAccountView, balance?: ChainBalance): TokenBalance[] {
  const native = nativeToken(chain, balance);
  const rest = (balance?.tokens ?? []).filter(
    (token) => token.denom !== native.denom && token.amount !== "0" && token.amount !== "",
  );
  return [native, ...rest];
}

function ChainOverlayPicker({
  label,
  chain,
  chains,
  balance,
  balances,
  hidden,
  trailing,
  onSelect,
}: {
  label: string;
  chain?: ChainAccountView;
  chains: ChainAccountView[];
  balance?: ChainBalance;
  balances?: Record<string, ChainBalance>;
  hidden: boolean;
  /** Replaces the balance shown next to each option. */
  trailing?: (option: ChainAccountView) => ReactNode;
  onSelect: (chainId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const decimals = chain?.entry.coinDecimals ?? 6;

  return (
    <section>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {label}
      </p>
      <PickerTrigger
        className="mt-1.5"
        expanded={open}
        onClick={() => setOpen(true)}
        aria-label={`${label}: ${chain?.entry.chainName ?? "pick a network"}`}
        icon={
          <TokenLogo
            src={chain?.iconUrl}
            symbol={chain?.entry.chainName ?? "?"}
            size={26}
            verified={chain?.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        }
        title={chain ? chainTicker(chain.entry) : "-"}
        subtitle={chain?.entry.chainName ?? "Pick a network"}
        detail={
          balance
            ? hidden
              ? "••••"
              : `${formatUnits(balance.available, decimals)} free`
            : undefined
        }
      />
      <ChainSheet
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        chains={chains}
        selectedId={chain?.chainId}
        onSelect={onSelect}
        trailing={(option) => {
          if (trailing) return trailing(option);
          const held = balances?.[option.chainId];
          if (!held) return null;
          return (
            <span className="font-mono text-[9.5px] tabular-nums text-fg-dim">
              {hidden ? "••••" : formatUnits(held.available, option.entry.coinDecimals)}
            </span>
          );
        }}
      />
    </section>
  );
}

function tokenKindLabel(token: TokenBalance): string {
  if (token.kind === "ibc") return "IBC";
  if (token.kind === "factory") return "Factory";
  if (token.kind === "other") return "Asset";
  return "Native";
}

function tokenLogoSrc(token: TokenBalance | undefined, fallback?: string): string | undefined {
  return token?.iconUrl || fallback;
}

function PartyRow({
  label,
  address,
  hint,
  onCopy,
}: {
  label: string;
  address: string;
  hint?: string;
  onCopy: (address: string, title: string) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">{label}</p>
        {hint ? (
          <p className="mt-0.5 truncate text-[12.5px] font-medium text-fg">{hint}</p>
        ) : null}
        <p className="mt-0.5 break-all font-mono text-[11px] leading-snug text-fg-muted">
          {address}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onCopy(address, `${label} copied`)}
        className={cn(
          "mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        <IconCopy width={11} height={11} />
        Copy
      </button>
    </div>
  );
}

/** Which token on the source chain is being moved. Native, IBC, factory, other. */
function TokenPicker({
  tokens,
  denom,
  hidden,
  fallbackIconUrl,
  onSelect,
}: {
  tokens: readonly TokenBalance[];
  denom: string;
  hidden: boolean;
  fallbackIconUrl?: string;
  onSelect: (denom: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const memory = usePickerMemory("token");
  const selected = tokens.find((token) => token.denom === denom) ?? tokens[0];
  const items = useMemo<PickerItem[]>(
    () =>
      tokens.map((token) => ({
        id: token.denom,
        label: token.displayName,
        sublabel: `${tokenKindLabel(token)} · ${shortDenom(token.denom)}`,
        keywords: [token.symbol, token.denom, token.kind, token.displayName],
        icon: (
          <TokenLogo
            src={tokenLogoSrc(token, fallbackIconUrl)}
            symbol={token.symbol}
            size={24}
          />
        ),
        trailing: (
          <span className="font-mono text-[9.5px] tabular-nums text-fg-dim">
            {hidden ? "••••" : formatUnits(token.amount, token.decimals)}
          </span>
        ),
      })),
    [tokens, hidden, fallbackIconUrl],
  );
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Token: ${selected?.displayName ?? "none"}`}
        disabled={tokens.length === 0}
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-w-0 max-w-[168px] shrink-0 items-center gap-1.5 rounded-full border border-[var(--z-line)] bg-[var(--z-surface-raised)] py-1.5 pl-1.5 pr-2.5",
          "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          focusRing,
        )}
      >
        <TokenLogo
          src={tokenLogoSrc(selected, fallbackIconUrl)}
          symbol={selected?.symbol ?? "?"}
          size={24}
        />
        <span className="min-w-0 text-left">
          <span className="block truncate text-[12.5px] font-semibold leading-none tracking-tight text-fg">
            {selected?.symbol ?? "Token"}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9px] leading-none text-fg-dim">
            {selected ? tokenKindLabel(selected) : "None"}
          </span>
        </span>
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Choose an asset"
        items={items}
        selectedId={selected?.denom}
        searchPlaceholder="Search native, IBC, factory, or any denom"
        favorites={memory.favorites}
        recents={memory.recents}
        onToggleFavorite={memory.toggleFavorite}
        emptyLabel="No assets on this network"
        onSelect={(id) => {
          memory.remember(id);
          onSelect(id);
        }}
      />
    </>
  );
}

/** How far a destination is, as the channel cache knows it. */
function ReachLabel({ reach }: { reach: ChainReach | undefined }) {
  if (!reach) {
    return <span className="font-mono text-[9px] text-fg-dim">no known channel</span>;
  }
  return (
    <span
      className={cn(
        "font-mono text-[9px]",
        reach.verified ? "text-[var(--z-success)]" : "text-fg-dim",
      )}
    >
      {reach.hops.length === 1 ? "direct" : `${reach.hops.length} hops`}
      {reach.verified ? ", open" : ""}
    </span>
  );
}

/** "channel-141 to osmosis-1, then channel-0 to cosmoshub-4". */
function routeSentence(hops: readonly RouteHopView[]): string {
  return hops
    .filter((hop) => hop.kind !== "swap" && hop.counterpartyChainId)
    .map((hop) => `${hop.channelId || "?"} to ${hop.counterpartyChainId}`)
    .join(", then ");
}

/** When an unrelayed packet stops being deliverable and its escrow refunds. */
function timeoutLabel(msg: BuiltMsg | undefined): string {
  const value = (msg?.value ?? {}) as { timeout_timestamp?: unknown };
  const nanos = typeof value.timeout_timestamp === "string" ? value.timeout_timestamp : "";
  if (!/^\d+$/.test(nanos)) return `${PACKET_TIMEOUT_MINUTES} min`;
  const at = new Date(Number(BigInt(nanos) / 1_000_000n));
  const clock = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${PACKET_TIMEOUT_MINUTES} min, refunded if not received by ${clock}`;
}

/** IBC denoms are long hashes; the start is enough to tell two apart. */
function shortDenom(denom: string): string {
  return denom.startsWith("ibc/") ? `${denom.slice(0, 14)}…` : denom;
}

export function SendScreen({
  chains,
  balances,
  initialChainId,
  initialMode,
  contacts,
  onContactsChanged,
  onBack,
  onOpenNfts,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  /** "cross" when opened from the old Bridge entry point. */
  initialMode?: SendMode;
  contacts: AddressBookEntry[];
  onContactsChanged?: () => void;
  onBack: () => void;
  onOpenNfts?: () => void;
}) {
  const signedSend = useSignedSend();
  const toast = useToast();
  const { hidden, settings } = usePrefs();
  const liveReads = settings.liveBalances;
  const [mode, setMode] = useState<SendMode>(initialMode ?? "send");
  const [chainId, setChainId] = useState(initialChainId ?? chains[0]?.chainId ?? "");
  const [destChainId, setDestChainId] = useState(
    () =>
      chains.find((c) => c.chainId !== (initialChainId ?? chains[0]?.chainId))?.chainId ??
      chains[1]?.chainId ??
      "",
  );
  const [denom, setDenom] = useState("");
  const [recipient, setRecipient] = useState("");
  /** Cross-chain To field stays closed until the user wants a different address. */
  const [toOpen, setToOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [manual, setManual] = useState<ManualChannel[]>([]);
  const [routeKey, setRouteKey] = useState<string | null>(null);
  // Bumped by the route panel's retry, so re-planning the same inputs actually
  // re-plans rather than reusing the settled answer.
  const [retryToken, setRetryToken] = useState(0);
  const [phase, setPhase] = useState<SendPhase>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [picker, setPicker] = useState<"book" | "qr" | null>(null);
  const [preview, setPreview] = useState<TxPreview | null>(null);
  const [pendingMsgs, setPendingMsgs] = useState<readonly BuiltMsg[] | null>(null);
  const [reviewedPlan, setReviewedPlan] = useState<RoutePlanView | null>(null);
  /** The route being followed. Survives a popup close through storage. */
  const [tracked, setTracked] = useState<PendingTransfer | null>(null);
  /** Who the transfer just signed went to, for the save-contact offer. */
  const [sentTo, setSentTo] = useState("");

  const kernel = useKernelSigning();
  const resolveAddresses = useResolveAddresses();
  const pendingRoutes = usePendingTransfers();

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const destChain = chains.find((c) => c.chainId === destChainId);
  const balance = chain ? balances[chain.chainId] : undefined;
  const cross = mode === "cross";
  const inclusion = useTxDetail(
    chain?.chainId ?? "",
    phase === "sent" && txHash && !cross ? txHash : "",
    phase === "sent" && Boolean(txHash) && !cross && liveReads,
    { intervalMs: 2_000, maxRetries: 60 },
  );

  const chainIdList = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const channelReach = useChannelReach(cross ? (chain?.chainId ?? "") : "", chainIdList);
  const knownReach = destChain ? channelReach.reach.get(destChain.chainId) : undefined;
  const routeOptions = destChain ? (channelReach.paths.get(destChain.chainId) ?? []) : [];
  const selectedRoute =
    routeOptions.find((option) => option.key === routeKey) ?? routeOptions[0];
  const discovery = useAutoDiscovery(
    chain?.chainId ?? "",
    destChain?.chainId ?? "",
    cross && liveReads && channelReach.ready && Boolean(destChain),
    channelReach.reload,
  );

  useEffect(() => {
    setRouteKey(null);
  }, [chain?.chainId, destChain?.chainId]);

  const routePins = useMemo<ManualChannel[]>(() => {
    if (!selectedRoute) return [];
    return selectedRoute.hops.flatMap((hop) =>
      hop.counterpartyChainId && hop.channelId
        ? [
            {
              fromChainId: hop.chainId,
              toChainId: hop.counterpartyChainId,
              channelId: hop.channelId,
              ...(hop.channelVerified ? { verdict: "verified" as const } : {}),
            },
          ]
        : [],
    );
  }, [selectedRoute]);

  const effectiveManual = useMemo(() => {
    const byPair = new Map<string, ManualChannel>();
    for (const pin of routePins) byPair.set(`${pin.fromChainId}>${pin.toChainId}`, pin);
    for (const pin of manual) byPair.set(`${pin.fromChainId}>${pin.toChainId}`, pin);
    return [...byPair.values()];
  }, [routePins, manual]);

  // Reachable networks first, fewest hops first; the rest keep their order.
  const destOptions = useMemo(() => {
    const hopsTo = (id: string) => channelReach.reach.get(id)?.hops.length ?? Infinity;
    return chains
      .filter((c) => c.chainId !== chain?.chainId)
      .map((c, index) => ({ c, index }))
      .sort((a, b) => hopsTo(a.c.chainId) - hopsTo(b.c.chainId) || a.index - b.index)
      .map(({ c }) => c);
  }, [chains, chain?.chainId, channelReach.reach]);

  const tokens = chain ? tokensOn(chain, balance) : [];
  const token = tokens.find((row) => row.denom === denom) ?? tokens[0];
  const decimals = token?.decimals ?? chain?.entry.coinDecimals ?? 6;
  const available = token ? BigInt(token.amount) : null;
  const amountUnits = toBaseUnits(amount, decimals);
  const feeReserve =
    chain && token
      ? reservedFeeUnits(chain.chainId, token.denom, settings)
      : 0n;
  const spendable =
    available !== null ? maxSendable(available, feeReserve) : null;
  const overBalance =
    amountUnits !== null && spendable !== null && amountUnits > spendable;
  const destSelf = destChain?.address?.trim() ?? "";
  const effectiveRecipient = recipient.trim() || (cross ? destSelf : "");
  const usingSelf = cross && !recipient.trim() && Boolean(destSelf);

  /* ---------------------------------------------------------------- *
   * Route planning (cross-send only)
   * ---------------------------------------------------------------- */

  const [settledPlan, setSettledPlan] = useState<{
    key: string;
    result: TransferPlanResult;
  } | null>(null);

  const recipientValid =
    isBech32(effectiveRecipient) &&
    (!cross || prefixOf(effectiveRecipient) === destChain?.entry.bech32Prefix);

  const planKey =
    cross &&
    liveReads &&
    chain?.address &&
    destChain &&
    token &&
    recipientValid &&
    amountUnits !== null &&
    amountUnits > 0n
      ? [
          chain.chainId,
          destChain.chainId,
          token.denom,
          amountUnits.toString(),
          effectiveRecipient,
          effectiveManual
            .map((m) => `${m.fromChainId}>${m.toChainId}:${m.port ?? ""}/${m.channelId}`)
            .join("|"),
          retryToken,
          channelReach.version,
        ].join("~")
      : "";

  useEffect(() => {
    if (!planKey) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void planTransfer({
        sourceChainId: chain!.chainId,
        destChainId: destChain!.chainId,
        inputDenom: token!.denom,
        amountBaseUnits: amountUnits!.toString(),
        sender: chain!.address,
        recipient: effectiveRecipient,
        manualChannels: effectiveManual,
        resolveAddresses,
        signal: controller.signal,
      }).then((next) => {
        if (!controller.signal.aborted) setSettledPlan({ key: planKey, result: next });
      });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // planKey folds in every input the plan depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  // Derived, so an answer for a recipient or amount the user has since edited
  // is never rendered as the current route.
  const result = settledPlan?.key === planKey ? settledPlan.result : null;
  const planning = Boolean(planKey) && settledPlan?.key !== planKey;
  const plan = result?.best ?? null;

  function pinChannel(channel: ManualChannel) {
    setManual((rows) => [
      ...rows.filter(
        (row) => row.fromChainId !== channel.fromChainId || row.toChainId !== channel.toChainId,
      ),
      channel,
    ]);
    channelReach.reload();
  }

  function unpinChannel(fromChainId: string, toChainId: string) {
    setManual((rows) =>
      rows.filter((row) => row.fromChainId !== fromChainId || row.toChainId !== toChainId),
    );
  }

  // The route before there is a plan to show: the cached path when there is
  // one, otherwise the single leg a direct transfer needs, so the channel can
  // still be entered by hand when nothing was found.
  const previewHops = useMemo((): RouteHopView[] => {
    if (!cross || !chain || !destChain) return [];
    if (selectedRoute) return [...selectedRoute.hops];
    const pinnedDirect = manual.some(
      (row) => row.fromChainId === chain.chainId && row.toChainId === destChain.chainId,
    );
    if (knownReach && !pinnedDirect) return [...knownReach.hops];
    return [
      {
        index: 0,
        chainId: chain.chainId,
        chainName: chain.entry.chainName,
        counterpartyChainId: destChain.chainId,
        counterpartyChainName: destChain.entry.chainName,
        channelId: "",
        port: "transfer",
        kind: "transfer",
      },
    ];
  }, [cross, chain, destChain, manual, knownReach, selectedRoute]);

  const routeHint = ((): string => {
    if (!chain || !destChain) return "";
    if (!liveReads) {
      return "Channels are read from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (!channelReach.ready) return "Reading the channel cache…";
    if (discovery.searching) {
      return `Reading open channels on ${chain.entry.chainName} and checking each hop…`;
    }
    if (!knownReach) {
      return discovery.error
        ? `${discovery.error} Use Modify to enter a channel you know.`
        : `No open channel found from ${chain.entry.chainName} to ${destChain.entry.chainName}. Use Modify to enter one you know.`;
    }
    if (routeOptions.length > 1) {
      return `${routeOptions.length} routes found. Pick one, then enter an amount.`;
    }
    return usingSelf
      ? `Enter an amount. Arrival is this wallet on ${destChain.entry.chainName} unless you add another address.`
      : "Enter an amount, and Zunia plans the transfer on this route.";
  })();

  /* ---------------------------------------------------------------- *
   * Same-chain fee (amino path, unchanged)
   * ---------------------------------------------------------------- */

  const localFee = useMemo(() => {
    if (!chain || cross) return null;
    const price = chain.entry.gasPriceStep?.[settings.feeSpeed] ?? 0.025;
    const gasLimit = Math.max(1, Math.ceil(200_000 * settings.gasAdjustment));
    return estimateFee({
      gasLimit,
      gasPrice: price,
      denom: chain.entry.feeMinimalDenom,
    });
  }, [chain, cross, settings.feeSpeed, settings.gasAdjustment]);

  /* ---------------------------------------------------------------- *
   * Validation
   * ---------------------------------------------------------------- */

  const expectedPrefix = cross
    ? destChain?.entry.bech32Prefix
    : chain?.entry.bech32Prefix;
  const recipientChainId = cross ? destChain?.chainId : chain?.chainId;

  const recipientState = useMemo(() => {
    const value = recipient.trim();
    if (!value) {
      if (cross && destSelf) {
        return {
          tone: "valid" as const,
          hint: destChain
            ? `This wallet on ${destChain.entry.chainName}`
            : "This wallet on the destination",
        };
      }
      return { tone: "default" as const, hint: undefined };
    }
    if (!isBech32(value)) {
      return { tone: "error" as const, hint: "Not a valid address. Check it for a typo." };
    }
    if (expectedPrefix && prefixOf(value) !== expectedPrefix) {
      return { tone: "error" as const, hint: `Expected a ${expectedPrefix}1… address` };
    }
    if (chain && value === chain.address && !cross) {
      return { tone: "error" as const, hint: "That is this wallet's address" };
    }
    const known = contacts.find((c) => c.address === value);
    return {
      tone: "valid" as const,
      hint: known ? `Saved as ${known.label}` : "Valid address",
    };
  }, [recipient, chain, contacts, expectedPrefix, cross, destSelf, destChain]);

  const blockedReason = useMemo((): string | null => {
    if (!chain) return "Enable at least one network first.";
    if (cross && !liveReads) {
      return "Sending to another chain plans the route from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (cross && kernel.reason) return kernel.reason;
    if (cross && !destChain) return "Pick a destination network.";
    if (cross && !effectiveRecipient) {
      return "This wallet has no address on the destination. Add one to continue.";
    }
    if (recipientState.tone !== "valid") return null;
    if (!amount) return null;
    if (amountUnits === null) return "That amount is not a number this chain can hold.";
    if (amountUnits <= 0n) return "Enter an amount above zero.";
    if (overBalance) return `More than the ${token?.symbol ?? "balance"} available.`;
    if (!cross) return null;
    if (planning) return null;
    if (result?.error) return result.error;
    if (!plan) {
      return (
        result?.warnings[0] ??
        `No channel path from ${chain.entry.chainName} to ${destChain?.entry.chainName ?? "there"}. Use Modify on the route to enter one.`
      );
    }
    return plan.blockedReason;
  }, [
    chain,
    cross,
    liveReads,
    kernel.reason,
    destChain,
    effectiveRecipient,
    recipientState.tone,
    amount,
    amountUnits,
    overBalance,
    token,
    planning,
    result,
    plan,
  ]);

  const canReview =
    blockedReason === null &&
    recipientState.tone === "valid" &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    (!cross || Boolean(plan));

  function applyPercent(pct: number) {
    if (available === null) return;
    const units = (maxSendable(available, feeReserve) * BigInt(pct)) / 100n;
    setAmount(formatUnitsExact(units.toString(), decimals));
  }

  /* ---------------------------------------------------------------- *
   * Review and sign
   * ---------------------------------------------------------------- */

  const review = useCallback(async () => {
    if (!chain || amountUnits === null) return;
    setError(null);
    if (!cross) {
      setPhase("confirm");
      return;
    }
    if (!plan) return;
    setBusy(true);
    try {
      const msgs = [
        buildTransferMsgFromPlan({
          view: plan,
          sender: chain.address,
          amountBaseUnits: amountUnits.toString(),
        }),
      ];
      const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
        chainId: chain.chainId,
        signerAddress: chain.address,
        msgs,
        feeSpeed: settings.feeSpeed,
        gasAdjustment: settings.gasAdjustment,
      });
      setPendingMsgs(msgs);
      // Captured here, not at signing: this is the plan the confirm screen
      // describes, and it is the one tracking must follow afterwards.
      setReviewedPlan(plan);
      setPreview(built);
      setPhase("confirm");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [chain, amountUnits, cross, plan, settings.feeSpeed, settings.gasAdjustment]);

  /** Moves a saved recipient up the Recent list. Best effort: the send already happened. */
  function countSend(address: string) {
    if (!contacts.some((contact) => contact.address === address)) return;
    void sendToBackground("TOUCH_ADDRESS_BOOK_ENTRY", { address })
      .then(() => onContactsChanged?.())
      .catch(() => undefined);
  }

  async function copyParty(value: string, title: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(title, { meta: truncateAddress(value, 10, 6) });
    } catch {
      toast("Could not copy", { tone: "danger" });
    }
  }

  async function confirmAndBroadcast() {
    if (!chain || amountUnits === null || !token) return;
    setBusy(true);
    setError(null);
    try {
      if (cross) {
        if (!pendingMsgs || !preview) return;
        const broadcastResult = await signedSend<{ txhash: string }>(
          "SIGN_AND_BROADCAST_TX",
          {
            chainId: chain.chainId,
            signerAddress: chain.address,
            msgs: pendingMsgs,
            memo: preview.preview.memo,
            fee: preview.fee,
            accountNumber: preview.accountNumber,
            sequence: preview.sequence,
            expectSignBytesHash: preview.preview.signBytesHash,
          },
        );
        if (reviewedPlan) {
          const record: PendingTransfer = {
            kind: "transfer",
            txHash: broadcastResult.txhash,
            chainId: chain.chainId,
            plan: reviewedPlan.plan,
            amountBaseUnits: amountUnits.toString(),
            label: `${amount} ${token.symbol} → ${destChain?.entry.chainName ?? "?"}`,
            startedAt: Date.now(),
          };
          // Persisted before the screen changes, so a popup that closes on the
          // next frame does not lose the only view of where the funds are.
          await savePendingTransfer(record);
          pendingRoutes.reload();
          setTracked(record);
        }
        setTxHash(broadcastResult.txhash);
        setSentTo(recipient.trim());
        countSend(recipient.trim());
        toast("Transfer sent", {
          meta: truncateAddress(broadcastResult.txhash, 6, 4),
          alert: true,
        });
      } else {
        const msgs = [
          msgSend({
            fromAddress: chain.address,
            toAddress: recipient.trim(),
            amount: [{ denom: token.denom, amount: amountUnits.toString() }],
          }),
        ];
        const broadcastResult = await signedSend<{ txhash: string }>(
          "SIGN_AND_BROADCAST",
          {
            chainId: chain.chainId,
            signerAddress: chain.address,
            msgs,
            memo: resolveTxMemo(memo, msgs),
            fee: localFee,
            gasLimit: 200_000,
          },
        );
        setTxHash(broadcastResult.txhash);
        setSentTo(recipient.trim());
        countSend(recipient.trim());
        toast("Transaction sent", {
          meta: truncateAddress(broadcastResult.txhash, 6, 4),
          alert: true,
        });
      }
      setPhase("sent");
    } catch (caught) {
      const message = signingError(caught);
      setError(message);
      if (message) toast(message, { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  /* ---------------------------------------------------------------- *
   * Tracking
   * ---------------------------------------------------------------- */

  const trackInput =
    phase === "sent" && tracked
      ? {
          plan: tracked.plan,
          sourceTxHash: tracked.txHash,
          expectedAmount: tracked.amountBaseUnits,
        }
      : null;
  const tracking = useRouteTracking(trackInput);

  // A settled transfer has nothing left to act on, so stop offering to resume it.
  const trackedHash = tracked?.txHash ?? null;
  const outcome = tracking.route ? routeOutcome(tracking.route) : null;
  const finished =
    outcome === "delivered" || outcome === "refunded" || outcome === "failed";
  useEffect(() => {
    if (!trackedHash || !finished) return;
    void removePendingTransfer(trackedHash);
  }, [trackedHash, finished]);

  if (!chain) {
    return (
      <ScreenScaffold title="Send" onBack={onBack}>
        <Callout tone="warning" title="No networks enabled">
          Enable at least one network before sending.
        </Callout>
      </ScreenScaffold>
    );
  }

  if (phase === "sent" && txHash) {
    if (cross && tracked) {
      const route = tracking.route;
      const failed = outcome === "failed" || route?.failure === "source-failed";
      return (
        <ScreenScaffold
          title={failed ? "Transfer failed" : "Transfer in flight"}
          footer={
            <Button className="w-full" variant="secondary" onClick={onBack}>
              Done
            </Button>
          }
        >
          <div className="pt-1">
            <PacketTracker
              compact
              hops={route?.hops ?? []}
              sourceTxHash={tracked.txHash}
              sourceChainId={tracked.chainId}
              failure={route?.failure ?? null}
              recoveryReady={false}
              txUrl={explorerTxUrl}
              loading={tracking.loading && !route}
              error={tracking.error}
              onRefresh={tracking.refresh}
              lastUpdatedAt={route?.updatedAt ?? null}
            />
            {failed ? (
              <Callout compact className="mt-3" tone="danger" title="Transaction failed">
                {route?.sourceError ||
                  "The source chain rejected this transfer. Nothing was sent."}
              </Callout>
            ) : (
              <Callout
                compact
                tone="neutral"
                className="mt-3"
                title="Runs without the popup"
              >
                Zunia follows this for a day and lists it on Activity until it
                arrives.
              </Callout>
            )}
            <div className="mt-3">
              {sentTo ? (
                <SaveContactPrompt
                  address={sentTo}
                  chainId={tracked.plan.destChainId}
                  contacts={contacts}
                  onSaved={() => onContactsChanged?.()}
                />
              ) : null}
            </div>
          </div>
        </ScreenScaffold>
      );
    }
    const sentUrl = explorerTxUrl(chain.chainId, txHash);
    const confirmed = inclusion.detail;
    const waiting =
      liveReads && !confirmed && (inclusion.retrying || inclusion.loading || inclusion.missing);
    const failed = Boolean(confirmed && !confirmed.success);
    const included = Boolean(confirmed?.success);
    const symbol = token?.symbol ?? chainTicker(chain.entry);
    const explorer = sentUrl ? (
      <Button className="w-full" asChild>
        <a href={sentUrl} target="_blank" rel="noreferrer">
          View on explorer
        </a>
      </Button>
    ) : undefined;

    if (waiting) {
      return (
        <ScreenScaffold title="Sending" onBack={onBack}>
          <div className="flex flex-col items-center px-2 pt-10 text-center">
            <div className="relative flex size-[76px] items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-[var(--z-line)]" />
              <span className="absolute inset-[6px] animate-spin rounded-full border-2 border-transparent border-t-accent" />
              <Spinner className="size-6 text-accent" />
            </div>
            <p className="mt-5 text-[18px] font-semibold tracking-tight text-fg">
              Confirming
            </p>
            <p className="mt-1.5 max-w-[240px] text-[12.5px] leading-snug text-fg-muted">
              Waiting for {chain.entry.chainName} to include this send.
            </p>
            <p className="mt-5 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
              {txHash}
            </p>
          </div>
        </ScreenScaffold>
      );
    }

    return (
      <ScreenScaffold
        title={failed ? "Rejected" : included ? "Sent" : "Broadcast"}
        onBack={onBack}
        footer={explorer}
      >
        <div className="flex flex-col items-center px-2 pt-8 text-center">
          <div
            className={cn(
              "flex size-[76px] items-center justify-center rounded-full",
              failed
                ? "bg-[var(--z-danger-fill)] text-[var(--z-danger)]"
                : "bg-[var(--z-success-fill)] text-[var(--z-success)]",
            )}
          >
            {failed ? (
              <span className="text-[28px] font-semibold leading-none">!</span>
            ) : (
              <IconCheck width={32} height={32} />
            )}
          </div>
          <p className="mt-5 text-[18px] font-semibold tracking-tight text-fg">
            {failed ? "Not included" : included ? "Included" : "Broadcast accepted"}
          </p>
          {amount ? (
            <p className="mt-2 text-[22px] font-semibold tracking-[-0.03em] tabular-nums text-fg">
              {amount} {symbol}
            </p>
          ) : null}
          <p className="mt-1.5 max-w-[250px] text-[12.5px] leading-snug text-fg-muted">
            {failed
              ? confirmed?.error || "The chain included this transaction with an error."
              : included
                ? `Confirmed on ${chain.entry.chainName}.`
                : `${chain.entry.chainName} has not confirmed it here yet. Open the explorer to follow it.`}
          </p>
          <p className="mt-4 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
            {txHash}
          </p>
        </div>
        <div className="mt-4">
          {sentTo ? (
            <SaveContactPrompt
              address={sentTo}
              chainId={chain.chainId}
              contacts={contacts}
              onSaved={() => onContactsChanged?.()}
            />
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

  if (phase === "confirm") {
    const memoInfo = preview?.packetMemo ?? null;
    const feeCoin = cross ? preview?.fee.amount[0] : localFee?.amount[0];
    const gas = cross ? preview?.fee.gas_limit : localFee?.gas;
    const signedPlan = reviewedPlan ?? plan;
    const forwarders = signedPlan?.plan.requiresPfm
      ? signedPlan.hops.filter((hop) => hop.kind === "forward").map((hop) => hop.chainName)
      : [];
    const eta = signedPlan?.plan.estimatedDurationSeconds ?? null;
    const unconfirmedPins = cross
      ? manual.filter(
          (pin) =>
            pin.verdict !== "verified" &&
            signedPlan?.hops.some(
              (hop) =>
                hop.chainId === pin.fromChainId &&
                hop.counterpartyChainId === pin.toChainId &&
                hop.channelId === pin.channelId,
            ),
        )
      : [];
    const confirmKind = !cross
      ? "send"
      : signedPlan?.plan.requiresPfm
        ? "ibc-forward"
        : "ibc";
    const confirmTitle =
      confirmKind === "send"
        ? "Confirm send"
        : confirmKind === "ibc-forward"
          ? "Confirm IBC route"
          : "Confirm IBC send";
    const signLabel =
      confirmKind === "send"
        ? "Sign send"
        : confirmKind === "ibc-forward"
          ? "Sign route"
          : "Sign IBC send";
    const shownMemo = cross
      ? preview?.preview.memo || resolveTxMemo("", pendingMsgs ?? [])
      : resolveTxMemo(
          memo,
          token
            ? [
                {
                  type: "cosmos-sdk/MsgSend",
                  value: {
                    amount: [
                      {
                        denom: token.denom,
                        amount: amountUnits?.toString() ?? "0",
                      },
                    ],
                  },
                },
              ]
            : [],
        );
    const toAddress = effectiveRecipient;
    const toContact = contacts.find((contact) => contact.address === toAddress);
    const symbol = token?.symbol ?? chainTicker(chain.entry);
    return (
      <ScreenScaffold
        title={confirmTitle}
        onBack={() => {
          setPhase("form");
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => {
                setPhase("form");
                setError(null);
              }}
            >
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => void confirmAndBroadcast()}
            >
              {busy ? "Signing…" : signLabel}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <section className="rounded-[18px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-4">
            <div className="flex items-start gap-3">
              <TokenLogo
                src={tokenLogoSrc(token, chain.iconUrl)}
                symbol={symbol}
                size={44}
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                  {confirmKind === "send"
                    ? "Send"
                    : confirmKind === "ibc-forward"
                      ? "Multi-hop IBC"
                      : "IBC transfer"}
                </p>
                <p className="mt-1 text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-fg">
                  {amount}{" "}
                  <span className="text-[15px] font-semibold tracking-[-0.02em] text-fg-muted">
                    {symbol}
                  </span>
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {token ? (
                    <Pill className="px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]">
                      {tokenKindLabel(token)}
                    </Pill>
                  ) : null}
                  {cross && destChain ? (
                    <Pill tone="accent" className="px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]">
                      {chain.entry.chainName} → {destChain.entry.chainName}
                    </Pill>
                  ) : (
                    <Pill className="px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]">
                      {chain.entry.chainName}
                    </Pill>
                  )}
                </div>
              </div>
            </div>
            {cross && destChain ? (
              <div className="mt-3.5 flex items-center gap-2 rounded-[12px] border border-[var(--z-line)] px-3 py-2">
                <TokenLogo
                  src={chain.iconUrl}
                  symbol={chain.entry.chainName}
                  size={22}
                  verified={chain.entry.inCosmosRegistry}
                />
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-muted">
                  {routeSentence(signedPlan?.hops ?? []) ||
                    `${chain.entry.chainName} → ${destChain.entry.chainName}`}
                </span>
                <TokenLogo
                  src={destChain.iconUrl}
                  symbol={destChain.entry.chainName}
                  size={22}
                  verified={destChain.entry.inCosmosRegistry}
                />
              </div>
            ) : null}
          </section>

          <section className="divide-y divide-[var(--z-line)] rounded-[16px] border border-[var(--z-line)] px-3.5 py-2.5">
            <PartyRow
              label="From"
              address={chain.address}
              hint="You"
              onCopy={copyParty}
            />
            <PartyRow
              label="To"
              address={toAddress}
              hint={
                toContact?.label ??
                (usingSelf
                  ? `This wallet · ${destChain?.entry.chainName ?? "destination"}`
                  : cross
                    ? destChain?.entry.chainName
                    : undefined)
              }
              onCopy={copyParty}
            />
          </section>

          <section className="flex flex-col gap-1.5 rounded-[16px] border border-[var(--z-line)] px-3.5 py-3">
            {confirmKind === "send" ? (
              <KeyValueRow label="Message" value="MsgSend" />
            ) : (
              <KeyValueRow
                label="Message"
                value={confirmKind === "ibc-forward" ? "MsgTransfer · PFM" : "MsgTransfer"}
              />
            )}
            {token?.kind === "ibc" && token.baseDenom ? (
              <KeyValueRow
                label="Origin"
                value={<TruncatedValue>{token.baseDenom}</TruncatedValue>}
              />
            ) : null}
            {token && (token.kind === "factory" || token.kind === "other") ? (
              <KeyValueRow
                label="Denom"
                value={<TruncatedValue>{token.denom}</TruncatedValue>}
              />
            ) : null}
            {forwarders.length > 0 ? (
              <KeyValueRow
                label="Forwarded by"
                value={<TruncatedValue>{forwarders.join(", ")}</TruncatedValue>}
              />
            ) : null}
            {cross ? (
              <KeyValueRow
                label="Timeout"
                value={<TruncatedValue>{timeoutLabel(pendingMsgs?.[0])}</TruncatedValue>}
              />
            ) : null}
            {cross && eta ? (
              <KeyValueRow
                label="Arrives in"
                value={`about ${Math.max(1, Math.round(eta / 60))} min`}
              />
            ) : null}
            <KeyValueRow label="Memo" value={<TruncatedValue>{shownMemo}</TruncatedValue>} />
          </section>

          {unconfirmedPins.map((pin) => (
            <Callout
              key={`${pin.fromChainId}>${pin.toChainId}`}
              tone="warning"
              title={`${pin.channelId} was entered by hand`}
            >
              Nothing confirmed that it leads from {pin.fromChainId} to {pin.toChainId}. If it
              goes somewhere else, the funds can land on another chain or come back as a
              refund after the timeout.
            </Callout>
          ))}

          {cross && memoInfo ? (
            <section className="rounded-[16px] border border-[var(--z-line)] px-3.5 py-3">
              <SectionLabel>What the packet memo will do</SectionLabel>
              <p className="mt-1.5 text-[11.5px] leading-snug text-fg">
                {memoInfo.summary}
              </p>
              {memoInfo.warnings.map((warning) => (
                <p key={warning} className="mt-1.5 text-[10.5px] text-[var(--z-warning)]">
                  {warning}
                </p>
              ))}
            </section>
          ) : null}

          <section className="rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={feeCoin?.amount}
              feeDecimals={chain.entry.feeDecimals}
              feeSymbol={feeTicker(chain.entry)}
              onChanged={() => {
                if (cross) void review();
              }}
            />
            {gas ? (
              <div className="mt-1.5">
                <KeyValueRow label="Gas" value={gas} />
              </div>
            ) : null}
          </section>

          {cross && preview?.feeNote ? (
            <Callout compact tone="warning" title="Fee is an estimate">
              {preview.feeNote}
            </Callout>
          ) : null}

          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : cross ? (
            <Callout tone="warning" title="Gas is paid on this chain">
              You pay gas only on {chain.entry.chainName}, in {feeTicker(chain.entry)}.
              Relayers carry the packet the rest of the way.
            </Callout>
          ) : (
            <p className="text-[11px] leading-snug text-fg-muted">
              This stays on {chain.entry.chainName}. The recipient can spend it as soon
              as the transaction is included.
            </p>
          )}
        </div>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title="Send"
      onBack={onBack}
      right={
        <span className="font-mono text-[9.5px] text-fg-dim">
          {truncateAddress(chain.address, 6, 4)}
        </span>
      }
      footer={
        <div>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onBack}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!canReview || busy}
              onClick={() => void review()}
            >
              {busy ? "Preparing…" : "Review"}
            </Button>
          </div>
          <DisabledReason reason={canReview ? null : blockedReason} />
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <ResumeTrackingBanner
          rows={pendingRoutes.rows.filter((row) => row.kind === "transfer")}
          onResume={(row) => {
            setMode("cross");
            setTracked(row);
            setSentTo("");
            setTxHash(row.txHash);
            setError(null);
            setPhase("sent");
          }}
          onDismiss={pendingRoutes.forget}
        />

        <Segmented<SendMode>
          size="sm"
          className="w-full"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setPhase("form");
            setRecipient("");
            setToOpen(false);
            setManual([]);
          }}
          options={[
            { value: "send", label: "Same chain" },
            { value: "cross", label: "Other chain" },
          ]}
        />

        <ChainOverlayPicker
          label={cross ? "From network" : "Network"}
          chain={chain}
          chains={chains}
          balance={balance}
          balances={balances}
          hidden={hidden}
          onSelect={(id) => {
            setChainId(id);
            setRecipient("");
            setToOpen(false);
            setAmount("");
            setDenom("");
            setManual([]);
            if (id === destChainId) {
              const other = chains.find((c) => c.chainId !== id);
              if (other) setDestChainId(other.chainId);
            }
          }}
        />

        {cross ? (
          <ChainOverlayPicker
            label="To network"
            chain={destChain}
            chains={destOptions}
            hidden={hidden}
            trailing={(option) => <ReachLabel reach={channelReach.reach.get(option.chainId)} />}
            onSelect={(id) => {
              setDestChainId(id);
              setRecipient("");
              setToOpen(false);
              setManual([]);
            }}
          />
        ) : null}

        {cross && destSelf && !toOpen ? (
          <p className="-mt-1 text-[11px] text-fg-dim">
            Arrives in this wallet.{" "}
            <button
              type="button"
              onClick={() => setToOpen(true)}
              className={cn("text-accent underline-offset-2 hover:underline", focusRing)}
            >
              Use another address
            </button>
          </p>
        ) : !cross || toOpen || !destSelf ? (
          <section>
            <div className="flex items-center justify-between gap-2">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-muted">
                To
              </p>
              {cross && destSelf ? (
                <button
                  type="button"
                  onClick={() => {
                    setRecipient("");
                    setToOpen(false);
                  }}
                  className={cn(
                    "font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent",
                    focusRing,
                  )}
                >
                  Use this wallet
                </button>
              ) : null}
            </div>
            <Input
              className="mt-1.5 h-12 py-0"
              style={{ paddingRight: "6.75rem" }}
              placeholder={`${expectedPrefix ?? "cosmos"}1…`}
              value={recipient}
              spellCheck={false}
              autoComplete="off"
              state={recipientState.tone}
              hint={recipientState.hint}
              onChange={(e) => setRecipient(e.target.value)}
              trailing={
                <AddressFieldActions
                  onScan={() => setPicker("qr")}
                  onBook={() => setPicker("book")}
                />
              }
            />
            {!recipient ? (
              <ContactChips
                contacts={contacts}
                expectedPrefix={expectedPrefix}
                expectedChainId={recipientChainId}
                onPick={(address) => {
                  setRecipient(address);
                  setToOpen(true);
                }}
              />
            ) : null}
          </section>
        ) : null}

        <section
          className={cn(
            "rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3",
            fieldFocusWithin,
          )}
        >
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-muted">
              You send
            </p>
            <p className="truncate font-mono text-[10px] tabular-nums text-fg-dim">
              {hidden
                ? "••••"
                : token
                  ? `${formatUnits(token.amount, decimals)} available`
                  : "balance unknown"}
            </p>
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <label className="sr-only" htmlFor="send-amount">
              Amount
            </label>
            <input
              id="send-amount"
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(decimalText(e.target.value))}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-left text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-fg outline-none",
                "placeholder:text-fg-faint",
              )}
            />
            <TokenPicker
              tokens={tokens}
              denom={token?.denom ?? ""}
              hidden={hidden}
              fallbackIconUrl={chain.iconUrl}
              onSelect={(next) => {
                setDenom(next);
                setAmount("");
                setManual([]);
              }}
            />
          </div>
          <div className="mt-2.5 flex gap-1">
            {PERCENTS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={available === null}
                onClick={() => applyPercent(pct)}
                className={cn(
                  "flex-1 rounded-full border border-[var(--z-line)] py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-muted",
                  "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  focusRing,
                )}
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            ))}
          </div>
          {overBalance ? (
            <p className="mt-2 text-[10.5px] text-[var(--z-danger-fg)]">
              More than the available balance.
            </p>
          ) : null}
        </section>

        {cross && destChain ? (
          plan || planning || result?.error ? (
            <RoutePreview
              compact
              title="Route"
              hops={plan?.hops ?? []}
              estimatedDurationSeconds={plan?.plan.estimatedDurationSeconds ?? null}
              warnings={plan?.warnings ?? result?.warnings ?? []}
              requiresPfm={plan?.plan.requiresPfm ?? false}
              gasChainName={chain.entry.chainName}
              loading={planning && !plan}
              error={result?.error ?? null}
              onRetry={() => setRetryToken((n) => n + 1)}
              footer={
                plan ? (
                  <div className="flex flex-col gap-2">
                    <RouteChoiceList
                      options={routeOptions}
                      selectedKey={selectedRoute?.key ?? ""}
                      onSelect={setRouteKey}
                    />
                    <HopChannelList
                      hops={plan.hops}
                      manual={manual}
                      onPick={pinChannel}
                      onClear={unpinChannel}
                    />
                  </div>
                ) : null
              }
            />
          ) : (
            <section className="flex flex-col gap-1.5">
              <SectionLabel>Route</SectionLabel>
              <RouteChoiceList
                options={routeOptions}
                selectedKey={selectedRoute?.key ?? ""}
                onSelect={setRouteKey}
              />
              {previewHops.length > 0 ? (
                <HopChannelList
                  hops={previewHops}
                  manual={manual}
                  onPick={pinChannel}
                  onClear={unpinChannel}
                />
              ) : null}
              <p
                className="flex items-center gap-1.5 text-[10.5px] leading-snug text-fg-muted"
                aria-live="polite"
              >
                {discovery.searching ? <Spinner className="size-3 shrink-0" /> : null}
                {routeHint}
              </p>
            </section>
          )
        ) : null}

        {!cross ? (
          <Input
            label="Memo (optional)"
            placeholder="Leave empty for a Zunia default"
            value={memo}
            maxLength={256}
            onChange={(e) => setMemo(e.target.value)}
          />
        ) : null}

        {onOpenNfts ? (
          <button
            type="button"
            onClick={onOpenNfts}
            className={cn(
              "w-full rounded-[14px] border border-[var(--z-line)] px-3.5 py-2.5 text-left",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
          >
            <span className="block text-[12.5px] font-medium text-fg">Send an NFT</span>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-fg-muted">
              Collectibles use their own transfer. Open NFTs to pick one.
            </span>
          </button>
        ) : null}

        <p className="flex items-center justify-center gap-1.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          <IconSend width={16} height={16} />
          Signed on this device
        </p>

        {chain.entry.network === "testnet" ? (
          <Pill tone="warning" className="self-start">
            testnet funds
          </Pill>
        ) : null}

        {error ? (
          <Callout tone="danger" title="Could not prepare the transfer">
            {error}
          </Callout>
        ) : null}
      </div>
      {picker === "book" ? (
        <AddressBookPicker
          contacts={contacts}
          expectedPrefix={expectedPrefix}
          expectedChainId={recipientChainId}
          onChanged={onContactsChanged}
          onClose={() => setPicker(null)}
          onPick={(address) => {
            setRecipient(address);
            setToOpen(true);
            setPicker(null);
          }}
        />
      ) : null}
      {picker === "qr" ? (
        <QrScanOverlay
          onClose={() => setPicker(null)}
          onScan={(address) => {
            setRecipient(address);
            setToOpen(true);
            setPicker(null);
          }}
        />
      ) : null}
    </ScreenScaffold>
  );
}
