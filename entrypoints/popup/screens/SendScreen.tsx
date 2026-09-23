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
  AddressChip,
  Avatar,
  Button,
  Callout,
  FeeSummary,
  Input,
  KeyValueRow,
  PacketTracker,
  Pill,
  ProgressTracker,
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
import type { AddressBookEntry } from "../../../lib/address-book";
import { explorerTxUrl } from "../../../config/interchain";
import { estimateFee, msgSend } from "../../../lib/amino-tx";
import {
  NO_VALUE,
  formatUnits,
  formatUnitsExact,
  isBech32,
  prefixOf,
} from "../../../lib/format";
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
import { IconSend } from "./icons";
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
    symbol: chain.entry.coinDenom,
    displayName: chain.entry.coinDenom,
    decimals: chain.entry.coinDecimals,
    ...(chain.iconUrl ? { iconUrl: chain.iconUrl } : {}),
  };
}

/** Every token held on a chain, its own first. */
function tokensOn(chain: ChainAccountView, balance?: ChainBalance): TokenBalance[] {
  const native = nativeToken(chain, balance);
  const rest = (balance?.tokens ?? []).filter((token) => token.denom !== native.denom);
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
          <Avatar
            src={chain?.iconUrl}
            fallback={chain?.entry.chainName ?? "?"}
            size={26}
          />
        }
        title={chain?.entry.coinDenom ?? "-"}
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

/** Which token on the source chain is being moved. Cross-send only. */
function TokenPicker({
  tokens,
  denom,
  hidden,
  onSelect,
}: {
  tokens: readonly TokenBalance[];
  denom: string;
  hidden: boolean;
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
        sublabel: shortDenom(token.denom),
        keywords: [token.symbol, token.denom],
        icon: <Avatar src={token.iconUrl} fallback={token.symbol} size={24} />,
        trailing: (
          <span className="font-mono text-[9.5px] tabular-nums text-fg-dim">
            {hidden ? "••••" : formatUnits(token.amount, token.decimals)}
          </span>
        ),
      })),
    [tokens, hidden],
  );
  if (tokens.length <= 1) return null;
  return (
    <section>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">Token</p>
      <PickerTrigger
        className="mt-1.5 py-2"
        expanded={open}
        onClick={() => setOpen(true)}
        aria-label={`Token: ${selected?.displayName ?? "none"}`}
        title={selected?.displayName ?? "-"}
        subtitle={selected ? shortDenom(selected.denom) : undefined}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Choose a token"
        items={items}
        selectedId={selected?.denom}
        searchPlaceholder="Search tokens"
        favorites={memory.favorites}
        recents={memory.recents}
        onToggleFavorite={memory.toggleFavorite}
        onSelect={(id) => {
          memory.remember(id);
          onSelect(id);
        }}
      />
    </section>
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
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  /** "cross" when opened from the old Bridge entry point. */
  initialMode?: SendMode;
  contacts: AddressBookEntry[];
  onContactsChanged?: () => void;
  onBack: () => void;
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
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [manual, setManual] = useState<ManualChannel[]>([]);
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

  const chainIdList = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const channelReach = useChannelReach(cross ? (chain?.chainId ?? "") : "", chainIdList);
  const knownReach = destChain ? channelReach.reach.get(destChain.chainId) : undefined;
  const discovery = useAutoDiscovery(
    chain?.chainId ?? "",
    destChain?.chainId ?? "",
    cross &&
      liveReads &&
      channelReach.ready &&
      Boolean(destChain) &&
      !(knownReach && knownReach.hops.length === 1 && knownReach.verified),
    channelReach.reload,
  );

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
  const overBalance =
    amountUnits !== null && available !== null && amountUnits > available;

  /* ---------------------------------------------------------------- *
   * Route planning (cross-send only)
   * ---------------------------------------------------------------- */

  const [settledPlan, setSettledPlan] = useState<{
    key: string;
    result: TransferPlanResult;
  } | null>(null);

  const recipientValid =
    isBech32(recipient.trim()) &&
    (!cross || prefixOf(recipient.trim()) === destChain?.entry.bech32Prefix);

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
          recipient.trim(),
          manual
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
        recipient: recipient.trim(),
        manualChannels: manual,
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
  }, [cross, chain, destChain, manual, knownReach]);

  const routeHint = ((): string => {
    if (!chain || !destChain) return "";
    if (!liveReads) {
      return "Channels are read from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (!channelReach.ready) return "Reading the channel cache…";
    if (discovery.searching) {
      return `Looking for a channel from ${chain.entry.chainName} to ${destChain.entry.chainName}…`;
    }
    if (!knownReach) {
      return discovery.error
        ? `${discovery.error} Use Modify to enter a channel you know.`
        : `No open channel found from ${chain.entry.chainName} to ${destChain.entry.chainName}. Use Modify to enter one you know.`;
    }
    return "Enter the recipient and an amount, and Zunia plans the transfer on this route.";
  })();

  /* ---------------------------------------------------------------- *
   * Same-chain fee (amino path, unchanged)
   * ---------------------------------------------------------------- */

  const localFee = useMemo(() => {
    if (!chain || cross) return null;
    return estimateFee({
      gasLimit: 200_000,
      gasPrice: chain.entry.gasPriceStep?.average ?? 0.025,
      denom: chain.entry.feeMinimalDenom,
    });
  }, [chain, cross]);

  /* ---------------------------------------------------------------- *
   * Validation
   * ---------------------------------------------------------------- */

  const expectedPrefix = cross
    ? destChain?.entry.bech32Prefix
    : chain?.entry.bech32Prefix;
  const recipientChainId = cross ? destChain?.chainId : chain?.chainId;

  const recipientState = useMemo(() => {
    const value = recipient.trim();
    if (!value) return { tone: "default" as const, hint: undefined };
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
  }, [recipient, chain, contacts, expectedPrefix, cross]);

  const blockedReason = useMemo((): string | null => {
    if (!chain) return "Enable at least one network first.";
    if (cross && !liveReads) {
      return "Sending to another chain plans the route from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (cross && kernel.reason) return kernel.reason;
    if (cross && !destChain) return "Pick a destination network.";
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
    const units = (available * BigInt(pct)) / 100n;
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
  }, [chain, amountUnits, cross, plan]);

  /** Moves a saved recipient up the Recent list. Best effort: the send already happened. */
  function countSend(address: string) {
    if (!contacts.some((contact) => contact.address === address)) return;
    void sendToBackground("TOUCH_ADDRESS_BOOK_ENTRY", { address })
      .then(() => onContactsChanged?.())
      .catch(() => undefined);
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
        toast("Transfer sent", { meta: truncateAddress(broadcastResult.txhash, 6, 4) });
      } else {
        const broadcastResult = await signedSend<{ txhash: string }>(
          "SIGN_AND_BROADCAST",
          {
            chainId: chain.chainId,
            signerAddress: chain.address,
            msgs: [
              msgSend({
                fromAddress: chain.address,
                toAddress: recipient.trim(),
                amount: [{ denom: token.denom, amount: amountUnits.toString() }],
              }),
            ],
            memo: memo || undefined,
            fee: localFee,
            gasLimit: 200_000,
          },
        );
        setTxHash(broadcastResult.txhash);
        setSentTo(recipient.trim());
        countSend(recipient.trim());
        toast("Transaction sent", { meta: truncateAddress(broadcastResult.txhash, 6, 4) });
      }
      setPhase("sent");
    } catch (caught) {
      setError(signingError(caught));
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
  const finished = outcome === "delivered" || outcome === "refunded";
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
      return (
        <ScreenScaffold
          title="Transfer in flight"
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
            <Callout
              tone="neutral"
              className="mt-3"
              title="This keeps running without the popup"
            >
              The transfer proceeds on chain whether or not Zunia is open. Zunia
              follows it for a day and lists it at the top of Activity until it
              arrives.
            </Callout>
            <div className="mt-3">
              <SaveContactPrompt
                address={sentTo}
                chainId={tracked.plan.destChainId}
                contacts={contacts}
                onSaved={() => onContactsChanged?.()}
              />
            </div>
          </div>
        </ScreenScaffold>
      );
    }
    const sentUrl = explorerTxUrl(chain.chainId, txHash);
    return (
      <ScreenScaffold
        title="Transfer sent"
        onBack={onBack}
        footer={
          <div className="flex gap-2">
            {sentUrl ? (
              <Button variant="secondary" className="flex-1" asChild>
                <a href={sentUrl} target="_blank" rel="noreferrer">
                  View on explorer
                </a>
              </Button>
            ) : null}
            <Button className="flex-1" onClick={onBack}>
              Done
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <ProgressTracker
            title="Waiting for a block"
            steps={[
              { label: "Signed", state: "done" },
              { label: "Broadcast", state: "done" },
              { label: "Included", state: "current" },
            ]}
            step={2}
            total={3}
          />
          <KeyValueRow
            label="Hash"
            value={<AddressChip address={txHash} />}
          />
          <SaveContactPrompt
            address={sentTo}
            chainId={chain.chainId}
            contacts={contacts}
            onSaved={() => onContactsChanged?.()}
          />
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
    return (
      <ScreenScaffold
        title="Confirm transfer"
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
              {busy ? "Signing…" : "Sign and send"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            <KeyValueRow
              label="Amount"
              value={`${amount} ${token?.symbol ?? chain.entry.coinDenom}`}
            />
            <KeyValueRow label="To" value={truncateAddress(recipient.trim(), 10, 8)} />
            <KeyValueRow
              label="Route"
              value={
                <TruncatedValue>
                  {cross
                    ? routeSentence(signedPlan?.hops ?? []) || "?"
                    : "Direct · MsgSend"}
                </TruncatedValue>
              }
            />
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
              <KeyValueRow label="Arrives in" value={`about ${Math.max(1, Math.round(eta / 60))} min`} />
            ) : null}
            {!cross && memo ? <KeyValueRow label="Memo" value={memo} /> : null}
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
            <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
              <SectionLabel>What the memo will do</SectionLabel>
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

          <FeeSummary
            rows={[
              {
                label: "Network fee",
                value: feeCoin
                  ? `${formatUnits(feeCoin.amount, chain.entry.feeDecimals)} ${chain.entry.feeDenom}`
                  : NO_VALUE,
              },
              { label: "Gas", value: gas ?? NO_VALUE },
              ...(cross && preview
                ? [
                    {
                      label: "Sign bytes",
                      value: `${preview.preview.signBytesHash.slice(0, 12)}…`,
                    },
                  ]
                : []),
            ]}
          />

          {cross && preview?.feeNote ? (
            <Callout tone="warning" title="Fee is an estimate">
              {preview.feeNote}
            </Callout>
          ) : null}

          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : (
            <Callout tone="info" title="Signed on this device">
              {cross
                ? `You pay gas only on ${chain.entry.chainName}, in ${chain.entry.feeDenom}. Relayers carry the packet the rest of the way.`
                : "Approving signs with your unlocked keyring and posts the tx to this chain's public REST endpoint."}
            </Callout>
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
            setManual([]);
          }}
          options={[
            { value: "send", label: "Same chain" },
            { value: "cross", label: "Other chain" },
          ]}
        />

        <ChainOverlayPicker
          label={cross ? "From" : "Asset"}
          chain={chain}
          chains={chains}
          balance={balance}
          balances={balances}
          hidden={hidden}
          onSelect={(id) => {
            setChainId(id);
            setRecipient("");
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
          <TokenPicker
            tokens={tokens}
            denom={token?.denom ?? ""}
            hidden={hidden}
            onSelect={(next) => {
              setDenom(next);
              setAmount("");
              setManual([]);
            }}
          />
        ) : null}

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
              setManual([]);
            }}
          />
        ) : null}

        <section>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">To</p>
          <Input
            className="mt-1.5"
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
              onPick={setRecipient}
            />
          ) : null}
        </section>

        <section
          className={cn(
            "rounded-[13px] border border-[var(--z-line)] px-3 py-3",
            fieldFocusWithin,
          )}
        >
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Amount
            </p>
            <p className="font-mono text-[9.5px] text-fg-dim">
              {hidden
                ? "••••"
                : token
                  ? `${formatUnits(token.amount, decimals)} available`
                  : "balance unknown"}
            </p>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <label className="sr-only" htmlFor="send-amount">
              Amount
            </label>
            <input
              id="send-amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-[28px] font-medium tracking-[-0.04em] text-fg outline-none",
                "placeholder:text-fg-faint",
              )}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-dim">
              {token?.symbol ?? chain.entry.coinDenom}
            </span>
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {PERCENTS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={available === null}
                onClick={() => applyPercent(pct)}
                className={cn(
                  "flex-1 rounded-full border border-[var(--z-line)] py-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-muted",
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
                  <HopChannelList
                    hops={plan.hops}
                    manual={manual}
                    onPick={pinChannel}
                    onClear={unpinChannel}
                  />
                ) : null
              }
            />
          ) : (
            <section className="flex flex-col gap-1.5">
              <SectionLabel>Route</SectionLabel>
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
            placeholder="Visible to everyone on chain"
            value={memo}
            maxLength={256}
            onChange={(e) => setMemo(e.target.value)}
          />
        ) : null}

        <section className="flex flex-col gap-1.5 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
          <KeyValueRow label="From" value={chain.entry.chainId} />
          {cross && destChain ? (
            <KeyValueRow label="To" value={destChain.entry.chainId} />
          ) : null}
          <KeyValueRow
            label="Gas price"
            value={`${chain.entry.gasPriceStep?.average ?? 0.025} ${chain.entry.feeMinimalDenom}`}
          />
        </section>

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
            setPicker(null);
          }}
        />
      ) : null}
      {picker === "qr" ? (
        <QrScanOverlay
          onClose={() => setPicker(null)}
          onScan={(address) => {
            setRecipient(address);
            setPicker(null);
          }}
        />
      ) : null}
    </ScreenScaffold>
  );
}
