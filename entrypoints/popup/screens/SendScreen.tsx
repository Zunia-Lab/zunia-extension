/**
 * Send, and cross-send.
 *
 * Same-chain send is a `MsgSend` on the wallet's long-standing amino path.
 * Cross-send is IBC, and it is planned by `@zunialab/interchain`: the engine
 * decides whether a wrapped token unwinds along its own trace or wraps again,
 * finds a path when no direct channel exists and composes the
 * packet-forward-middleware memo for it, and reports which channels anyone has
 * actually verified. The hand-rolled channel discovery this screen used to call
 * (`lib/ibc-channels.ts`) is gone.
 *
 * The user can override the channel on any hop. Discovery fails on chains with
 * slow or incomplete LCDs, and a user who knows the channel must still be able
 * to proceed — with the fact that nobody checked it stated, not hidden.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  FeeSummary,
  Input,
  KeyValueRow,
  PacketTracker,
  Pill,
  RoutePreview,
  ScreenScaffold,
  Segmented,
  SectionLabel,
  TransferSent,
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
  type RoutePlanView,
  type TransferPlanResult,
} from "../../../lib/route-plan";
import {
  removePendingTransfer,
  savePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import type { TxPreview } from "../../../lib/tx-kernel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { OverlayMenu, OverlayMenuItem } from "../components/OverlayMenu";
import {
  AddressBookPicker,
  AddressFieldActions,
  QrScanOverlay,
} from "../components/AddressFieldExtras";
import {
  DisabledReason,
  HopChannelList,
  ResumeTrackingBanner,
  TruncatedValue,
  toBaseUnits,
  useKernelSigning,
  usePendingTransfers,
  useResolveAddresses,
  useRouteTracking,
} from "./interchain-ui";
import { IconChevronDown, IconSend } from "./icons";

const PERCENTS = [25, 50, 75, 100] as const;
type SendMode = "send" | "cross";
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
  hidden,
  onSelect,
}: {
  label: string;
  chain?: ChainAccountView;
  chains: ChainAccountView[];
  balance?: ChainBalance;
  hidden: boolean;
  onSelect: (chainId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const decimals = chain?.entry.coinDecimals ?? 6;

  return (
    <section>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {label}
      </p>
      <div className="relative mt-1.5">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-3 py-2.5 text-left",
            "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <Avatar
            src={chain?.iconUrl}
            fallback={chain?.entry.chainName ?? "?"}
            size={26}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">
              {chain?.entry.coinDenom ?? "—"}
            </span>
            <span className="block truncate font-mono text-[9.5px] text-fg-dim">
              {chain?.entry.chainName ?? "Pick a network"}
            </span>
          </span>
          {balance ? (
            <span className="shrink-0 font-mono text-[10px] text-fg-dim">
              {hidden ? "••••" : `${formatUnits(balance.available, decimals)} free`}
            </span>
          ) : null}
          <IconChevronDown
            width={16}
            height={16}
            className={cn(
              "shrink-0 text-fg-dim transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        <OverlayMenu open={open} onClose={() => setOpen(false)}>
          {chains.map((option) => (
            <OverlayMenuItem
              key={option.chainId}
              selected={option.chainId === chain?.chainId}
              onSelect={() => {
                onSelect(option.chainId);
                setOpen(false);
              }}
            >
              <Avatar src={option.iconUrl} fallback={option.entry.chainName} size={20} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                {option.entry.chainName}
              </span>
              <span className="font-mono text-[9px] uppercase text-fg-dim">
                {option.entry.coinDenom}
              </span>
            </OverlayMenuItem>
          ))}
        </OverlayMenu>
      </div>
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
  const selected = tokens.find((token) => token.denom === denom) ?? tokens[0];
  if (tokens.length <= 1) return null;
  return (
    <section>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">Token</p>
      <div className="relative mt-1.5">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-[12px] border border-[var(--z-line)] px-3 py-2 text-left",
            "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <span className="min-w-0">
            <span className="block truncate text-[12px] text-fg">
              {selected?.displayName ?? "—"}
            </span>
            <span className="block truncate font-mono text-[9px] text-fg-dim">
              {selected && selected.denom.startsWith("ibc/")
                ? `${selected.denom.slice(0, 14)}…`
                : (selected?.denom ?? "")}
            </span>
          </span>
          <IconChevronDown width={16} height={16} className="shrink-0 text-fg-dim" />
        </button>
        <OverlayMenu open={open} onClose={() => setOpen(false)}>
          {tokens.map((token) => (
            <OverlayMenuItem
              key={token.denom}
              selected={token.denom === selected?.denom}
              onSelect={() => {
                onSelect(token.denom);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                {token.displayName}
              </span>
              <span className="font-mono text-[9px] tabular-nums text-fg-dim">
                {hidden ? "••••" : formatUnits(token.amount, token.decimals)}
              </span>
            </OverlayMenuItem>
          ))}
        </OverlayMenu>
      </div>
    </section>
  );
}

export function SendScreen({
  chains,
  balances,
  initialChainId,
  contacts,
  onBack,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  contacts: AddressBookEntry[];
  onBack: () => void;
}) {
  const { hidden, settings } = usePrefs();
  const liveReads = settings.liveBalances;
  const [mode, setMode] = useState<SendMode>("send");
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

  const kernel = useKernelSigning();
  const resolveAddresses = useResolveAddresses();
  const pendingRoutes = usePendingTransfers();

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const destChain = chains.find((c) => c.chainId === destChainId);
  const balance = chain ? balances[chain.chainId] : undefined;
  const cross = mode === "cross";

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
          manual.map((m) => `${m.fromChainId}>${m.toChainId}:${m.channelId}`).join("|"),
          retryToken,
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

  const recipientState = useMemo(() => {
    const value = recipient.trim();
    if (!value) return { tone: "default" as const, hint: undefined };
    if (!isBech32(value)) {
      return { tone: "error" as const, hint: "Not a valid bech32 address" };
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
      return "Cross-send plans the route from public endpoints. Turn on live balances in Settings → Preferences.";
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
        `No channel path from ${chain.entry.chainName} to ${destChain?.entry.chainName ?? "there"}. Add a channel by hand below.`
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

  async function confirmAndBroadcast() {
    if (!chain || amountUnits === null || !token) return;
    setBusy(true);
    setError(null);
    try {
      if (cross) {
        if (!pendingMsgs || !preview) return;
        const broadcastResult = await sendToBackground<{ txhash: string }>(
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
      } else {
        const broadcastResult = await sendToBackground<{ txhash: string }>(
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
      }
      setPhase("sent");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
  const finished = tracking.route?.settled === true;
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
              remembers this route for a day, so you can reopen this view from Send.
            </Callout>
          </div>
        </ScreenScaffold>
      );
    }
    return (
      <ScreenScaffold title="Transfer sent" onBack={onBack}>
        <TransferSent
          hash={txHash}
          steps={[
            { label: "Signed", state: "done" },
            { label: "Broadcast", state: "done" },
            { label: "Included", state: "current" },
          ]}
          step={2}
          total={3}
          onDone={onBack}
        />
      </ScreenScaffold>
    );
  }

  if (phase === "confirm") {
    const memoInfo = preview?.packetMemo ?? null;
    const feeCoin = cross ? preview?.fee.amount[0] : localFee?.amount[0];
    const gas = cross ? preview?.fee.gas_limit : localFee?.gas;
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
                    ? `IBC · ${plan?.hops.map((hop) => hop.channelId).filter(Boolean).join(" → ") || "?"}`
                    : "Direct · MsgSend"}
                </TruncatedValue>
              }
            />
            {!cross && memo ? <KeyValueRow label="Memo" value={memo} /> : null}
          </section>

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
                  : "—",
              },
              { label: "Gas", value: gas ?? "—" },
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
      <div className="flex flex-col gap-3.5 pt-1">
        <ResumeTrackingBanner
          rows={pendingRoutes.rows.filter((row) => row.kind === "transfer")}
          onResume={(row) => {
            setMode("cross");
            setTracked(row);
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
            { value: "send", label: "Send" },
            { value: "cross", label: "Cross-send" },
          ]}
        />

        <ChainOverlayPicker
          label={cross ? "From" : "Asset"}
          chain={chain}
          chains={chains}
          balance={balance}
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
            chains={chains.filter((c) => c.chainId !== chain.chainId)}
            hidden={hidden}
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
          {contacts.length > 0 && !recipient ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {contacts.slice(0, 4).map((contact) => (
                <li key={contact.id}>
                  <button
                    type="button"
                    onClick={() => setRecipient(contact.address)}
                    className={cn(
                      "rounded-full border border-[var(--z-line)] px-2.5 py-1 text-[10.5px] text-fg-muted",
                      "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                      focusRing,
                    )}
                  >
                    {contact.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
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
            emptyTitle={liveReads ? "No route yet" : "Route planning is off"}
            emptyDescription={
              liveReads
                ? "Enter a valid recipient and an amount, and Zunia will plan the hops."
                : "Turn on live balances in Settings → Preferences so Zunia can read channels."
            }
            footer={
              plan ? (
                <HopChannelList
                  hops={plan.hops}
                  manual={manual}
                  onPick={(channel) =>
                    setManual((rows) => [
                      ...rows.filter(
                        (row) =>
                          row.fromChainId !== channel.fromChainId ||
                          row.toChainId !== channel.toChainId,
                      ),
                      channel,
                    ])
                  }
                  onClear={(fromChainId, toChainId) =>
                    setManual((rows) =>
                      rows.filter(
                        (row) =>
                          row.fromChainId !== fromChainId || row.toChainId !== toChainId,
                      ),
                    )
                  }
                />
              ) : null
            }
          />
        ) : null}

        {/*
          RoutePreview drops its footer in the empty state, and that is exactly
          when the channel editor is needed: discovery failed and there is no
          route to hang it off. The one leg a cross-send needs is known anyway.
        */}
        {cross && destChain && !plan ? (
          <section>
            <SectionLabel>Channel</SectionLabel>
            <p className="mb-1.5 mt-1 text-[10.5px] leading-snug text-fg-muted">
              Nothing has confirmed a path yet. Pick or type the channel and Zunia will
              plan again.
            </p>
            <HopChannelList
              hops={[
                {
                  index: 0,
                  chainId: chain.chainId,
                  chainName: chain.entry.chainName,
                  counterpartyChainId: destChain.chainId,
                  counterpartyChainName: destChain.entry.chainName,
                  channelId: "",
                  port: "transfer",
                  kind: "transfer" as const,
                },
              ]}
              manual={manual}
              onPick={(channel) =>
                setManual((rows) => [
                  ...rows.filter(
                    (row) =>
                      row.fromChainId !== channel.fromChainId ||
                      row.toChainId !== channel.toChainId,
                  ),
                  channel,
                ])
              }
              onClear={(fromChainId, toChainId) =>
                setManual((rows) =>
                  rows.filter(
                    (row) =>
                      row.fromChainId !== fromChainId || row.toChainId !== toChainId,
                  ),
                )
              }
            />
          </section>
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
