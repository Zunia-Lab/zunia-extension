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
 *
 * Every token is drawn from its identity (lib/token-identity.ts): the picker,
 * the pill and the review name it by its ticker, say where it is held and who
 * issued it, and never use a chain's logo as a token's. Amounts are typed and
 * converted with the exponent the balance row gives the token
 * (lib/send-arrival.ts `sendTokenIdentity`), so a typed amount signs what it
 * always did, and a token whose decimals nobody knows takes only Max. The
 * review of a transfer to another chain also says what the recipient ends up
 * holding, and warns when that is a re-wrapped voucher no registry names.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  TokenLogo,
  Callout,
  Input,
  KeyValueRow,
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
import { normalizeChannelId, type BuiltMsg } from "@zunialab/interchain";

import type { ChainBalance, TokenBalance } from "../../../lib/balances";
import {
  chainTicker,
  feeTicker,
  findCatalogEntry,
  type CatalogEntry,
} from "../../../lib/chain-catalog";
import type { AddressBookEntry } from "../../../lib/address-book";
import { PACKET_TIMEOUT_MINUTES, explorerTxUrl } from "../../../config/interchain";
import { estimateFee, msgSend } from "../../../lib/amino-tx";
import { resolveTxMemo } from "../../../lib/tx-memo";
import { decimalText, isBech32, prefixOf } from "../../../lib/format";
import { maxSendable, reservedFeeUnits } from "../../../lib/fee-prefs";
import { sendToBackground } from "../../../lib/popup-client";
import {
  buildTransferMsgFromPlan,
  planTransfer,
  type ChannelHopCheck,
  type ManualChannel,
  type RouteHopView,
  type RoutePlanView,
  type TransferPlanResult,
} from "../../../lib/route-plan";
import {
  removePendingTransfer,
  savePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import { routeOutcome } from "../../../lib/packet-tracking";
import {
  exactAmountText,
  issuerText,
  migrateStoredTokenMemory,
  migrateTokenIds,
  routeNotes,
  sendArrival,
  sendTokenIdentity,
  transferLabel,
  withRegistryEnds,
  type SendArrival,
} from "../../../lib/send-arrival";
import {
  MAX_ONLY_NOTE,
  amountFieldText,
  canTypeAmount,
  formatTokenAmount,
  type AmountIdentity,
} from "../../../lib/token-amount";
import {
  identityOf,
  shortDenom,
  tokenKindLabel,
  type TokenIdentity,
} from "../../../lib/token-identity";
import type { TxPreview } from "../../../lib/tx-kernel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useTxDetail } from "../hooks/useChainQuery";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { ChainSheet, PickerTrigger } from "../components/ChainSheet";
import { PickerSheet, type PickerItem } from "../components/PickerSheet";
import {
  TokenPill,
  TokenTicker,
  networkTag,
  provenanceLabel,
  tokenA11yName,
  tokenLocationText,
  tokenPickerItem,
} from "../components/TokenLabel";
import {
  ConfirmFooter,
  RawTxDisclosure,
  ResultFooter,
  ReviewAmount,
  ReviewArrow,
  ReviewCard,
  ReviewDisclosure,
  ReviewFact,
  ReviewFacts,
  TransferProgress,
  TxStatusHero,
  explainTxError,
  rawTxJson,
} from "../components/TxReview";
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
import { IconCopy, IconSend } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";

const PERCENTS = [25, 50, 75, 100] as const;
/** A planner note that names a channel: why the chains refused that channel. */
const NAMES_A_CHANNEL = /\bchannel-\d+\b/;
export type SendMode = "send" | "cross";
type SendPhase = "form" | "confirm" | "sent";

/** A held row, and the identity Send names, scales and converts it with. */
export interface SendToken {
  readonly token: TokenBalance;
  readonly identity: TokenIdentity;
}

/**
 * What the review showed and what gets signed, captured when the review
 * opens, so neither moves if the balances refresh underneath it.
 */
export interface ReviewedSend {
  readonly chainId: string;
  /** The exact bank denom the message carries. */
  readonly denom: string;
  /** The token as the review names it, with the exponent the amount was typed with. */
  readonly identity: TokenIdentity;
  /** Base units signed. */
  readonly units: bigint;
}

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

/**
 * A chain's own coin, as its chain-level balance is shown: the catalog's
 * ticker and exponent, the ones Home's chain rows and Earn use.
 */
function chainCoin(entry: CatalogEntry): AmountIdentity {
  return {
    decimals: entry.coinDecimals,
    decimalsKnown: true,
    ticker: chainTicker(entry),
    denom: entry.coinMinimalDenom,
    provenance: "native",
  };
}

function chainNameOf(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
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
          balance && chain
            ? hidden
              ? "••••"
              : `${formatTokenAmount(balance.available, chainCoin(chain.entry), "list")} free`
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
              {formatTokenAmount(held.available, chainCoin(option.entry), "list", { hidden })}
            </span>
          );
        }}
      />
    </section>
  );
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

/**
 * An exact denom, short on screen and whole in the tooltip and on the
 * clipboard: `ibc/498A…6BA6E4`, copied as all 68 characters. The button's
 * name says the short form it shows (`Copy denom ibc/498A…6BA6E4`), so a
 * voice user can say what they see and a screen reader is not read 64 hex
 * digits.
 */
export function CopyDenom({
  denom,
  what,
  onCopy,
}: {
  denom: string;
  /** What the denom is, for the button's name and the toast: `Denom`. */
  what: string;
  onCopy: (value: string, title: string) => void;
}) {
  return (
    <button
      type="button"
      title={denom}
      aria-label={`Copy ${what.toLowerCase()} ${shortDenom(denom)}`}
      onClick={() => onCopy(denom, `${what} copied`)}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-1 font-mono text-fg-muted [word-break:normal]",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
        focusRing,
      )}
    >
      <span className="min-w-0 truncate">{shortDenom(denom)}</span>
      <IconCopy width={11} height={11} className="shrink-0 text-accent" />
    </button>
  );
}

/**
 * An exact amount split for display: the figure, then its unit. `1.5` and
 * `USDC.n`; `12340000` and `base units IBC·0123` when the decimals are
 * unknown, so the large figure stays one number.
 */
function amountParts(units: string | bigint, identity: TokenIdentity): { figure: string; unit: string } {
  const [figure = "", ...words] = exactAmountText(units, identity).split(" ");
  return { figure, unit: [...words, identity.ticker].join(" ") };
}

/**
 * A review value shown whole: it wraps between words, and inside a word only
 * when one word is wider than the row. The memo is written on chain and the
 * timeout says when a refund comes, so neither is clipped.
 */
function WholeValue({ children }: { children: string }) {
  return <span className="[word-break:normal]">{children}</span>;
}

/**
 * The "Arrives as" value: the token the recipient holds and where, then its
 * exact denom to copy. When the plan could not compute the denom, only that
 * is said.
 */
function ArrivalValue({
  arrival,
  onCopy,
}: {
  arrival: SendArrival;
  onCopy: (value: string, title: string) => void;
}) {
  return (
    <span className="inline-flex max-w-full flex-col items-end gap-0.5">
      <span
        className={cn(
          "[word-break:normal]",
          arrival.warning ? "text-[var(--z-warning-fg)]" : "text-fg",
        )}
      >
        {arrival.text}
      </span>
      {arrival.denom ? (
        <CopyDenom denom={arrival.denom} what="Arrival denom" onCopy={onCopy} />
      ) : null}
    </span>
  );
}

/**
 * One picker row from TokenLabel's builder: the ticker (drawn whole, so its
 * suffix and any `·hash` stay in view), `Noble USDC · on Osmosis`, the token's
 * logo with its chain's badge, the balance, and the seal said aloud, as Swap's
 * rows are. `labelNode` and `srNote` are the picker's own optional fields.
 *
 * Two adjustments to the shared row, both for what a 360px sheet can hold:
 * - The ticker is drawn by TokenTicker in two boxes (family, then suffix),
 *   which a screen reader would name `USDC .n`; it is hidden from assistive
 *   tech and the ticker is said whole instead, so the name holds the label
 *   as written.
 * - A balance in base units (`5000000000000000000 base units` for allSHIB)
 *   wraps within a third of the row instead of squeezing the ticker to `I…`
 *   and the location line to one word per line.
 */
export function sendPickerItem(
  row: SendToken,
  hidden: boolean,
): PickerItem & { labelNode?: ReactNode; srNote?: string } {
  const seal = provenanceLabel(row.identity);
  const item = tokenPickerItem(row.identity, {
    amount: row.token.amount,
    hidden,
    locationChain: true,
  });
  return {
    ...item,
    labelNode: (
      <>
        <span aria-hidden="true" className="block min-w-0">
          <TokenTicker identity={row.identity} />
        </span>
        <span className="sr-only">{row.identity.ticker}</span>
      </>
    ),
    ...(item.trailing
      ? {
          trailing: (
            <span className="block max-w-[112px] font-mono text-[9.5px] leading-snug tabular-nums text-fg-dim [overflow-wrap:anywhere]">
              {formatTokenAmount(row.token.amount, row.identity, "picker", { hidden })}
            </span>
          ),
        }
      : {}),
    ...(seal ? { srNote: seal } : {}),
  };
}

/**
 * Which token on the source chain is being moved, by ticker and origin. Picks
 * are remembered as `${chainId}:${denom}`, the key Swap's pickers keep; picks
 * the old Send picker kept by bare denom count as this chain's when it offers
 * that denom, and are rewritten in storage once.
 */
function TokenPicker({
  chainId,
  rows,
  selected,
  hidden,
  onSelect,
}: {
  chainId: string;
  rows: readonly SendToken[];
  selected: SendToken | undefined;
  hidden: boolean;
  onSelect: (row: SendToken) => void;
}) {
  const [open, setOpen] = useState(false);
  const memory = usePickerMemory("token");
  const denoms = rows.map((row) => row.token.denom);
  const denomList = denoms.join("\n");
  useEffect(() => {
    if (!chainId || !denomList) return;
    void migrateStoredTokenMemory(chainId, denomList.split("\n"));
  }, [chainId, denomList]);
  const items = rows.map((row) => sendPickerItem(row, hidden));
  const identity = selected?.identity;
  const verified = identity && provenanceLabel(identity) ? ", verified" : "";
  return (
    <>
      <TokenPill
        identity={identity}
        chevron={false}
        emptyLabel="Token"
        aria-label={identity ? `Token: ${tokenA11yName(identity)}${verified}` : "Token: none"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={rows.length === 0}
        onClick={() => setOpen(true)}
      />
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Choose an asset"
        items={items}
        selectedId={identity?.key}
        searchPlaceholder="Search a ticker, chain or denom"
        favorites={migrateTokenIds(memory.favorites, chainId, denoms)}
        recents={migrateTokenIds(memory.recents, chainId, denoms)}
        onToggleFavorite={memory.toggleFavorite}
        emptyLabel="No assets on this network"
        onSelect={(id) => {
          const row = rows.find((candidate) => candidate.identity.key === id);
          if (!row) return;
          memory.remember(id);
          onSelect(row);
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

/** "channel-141 to Osmosis, then channel-0 to Cosmos Hub". */
function routeSentence(hops: readonly RouteHopView[]): string {
  return hops
    .filter((hop) => hop.kind !== "swap" && hop.counterpartyChainId)
    .map(
      (hop) =>
        `${hop.channelId || "?"} to ${hop.counterpartyChainName ?? hop.counterpartyChainId}`,
    )
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

/** The route the screen previews, as pins, so the plan follows that route. */
export function routePinsOf(route: Pick<ChainReach, "hops"> | undefined): ManualChannel[] {
  if (!route) return [];
  return route.hops.flatMap((hop) =>
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
}

/**
 * The screen's pins, with a channel the user entered replacing any on the
 * same leg, each with the registry's far end when it has none
 * (lib/send-arrival.ts `withRegistryEnds`): without it the planner cannot
 * compute the denom a wrapped token arrives as.
 */
export function mergePins(
  screen: readonly ManualChannel[],
  user: readonly ManualChannel[],
): ManualChannel[] {
  const byPair = new Map<string, ManualChannel>();
  for (const pin of screen) byPair.set(`${pin.fromChainId}>${pin.toChainId}`, pin);
  for (const pin of user) byPair.set(`${pin.fromChainId}>${pin.toChainId}`, pin);
  return withRegistryEnds([...byPair.values()]);
}

/**
 * Whether a failed channel check is on a channel this screen pinned on its
 * own (the route it previews), not one the user entered for that leg.
 */
function pinnedByScreen(
  failed: ChannelHopCheck,
  screen: readonly ManualChannel[],
  user: readonly ManualChannel[],
): boolean {
  const onLeg = (pin: ManualChannel) =>
    pin.fromChainId === failed.sourceChainId && pin.toChainId === failed.destChainId;
  if (user.some(onLeg)) return false;
  const channel = normalizeChannelId(failed.channelId);
  return screen.some((pin) => onLeg(pin) && normalizeChannelId(pin.channelId) === channel);
}

/** The one message a same-chain send signs, built the same way for the review and the signature. */
export function sameChainMsgs(fromAddress: string, toAddress: string, reviewed: ReviewedSend) {
  return [
    msgSend({
      fromAddress,
      toAddress,
      amount: [{ denom: reviewed.denom, amount: reviewed.units.toString() }],
    }),
  ];
}

/**
 * The memo a transfer is shown and signed with: the one its preview was built
 * over, which the review set to the chain-aware default. Should a preview
 * come back without one, the same default is passed explicitly, so the kernel
 * never writes a memo other than the one shown.
 */
export function transferMemo(
  preview: TxPreview | null,
  msgs: readonly BuiltMsg[] | null,
  chainId: string,
): string {
  return preview?.preview.memo || resolveTxMemo("", msgs ?? [], chainId);
}

/**
 * The memo a same-chain send is shown and signed with: the user's text, or
 * the default naming the coin as the reviewed chain holds it (`Send USDC.n ·
 * by Zunia-wallet` for Noble USDC, on Noble and on Osmosis alike).
 */
export function sameChainMemo(
  userMemo: string,
  fromAddress: string,
  toAddress: string,
  reviewed: ReviewedSend,
): string {
  return resolveTxMemo(userMemo, sameChainMsgs(fromAddress, toAddress, reviewed), reviewed.chainId);
}

export function SendScreen({
  chains,
  balances,
  initialChainId,
  initialMode,
  initialDenom,
  initialDestChainId,
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
  /** The token to open on: its exact bank denom on `initialChainId` (Swap's move to Osmosis). */
  initialDenom?: string;
  /** The destination to open other-chain mode on, when it is an enabled network. */
  initialDestChainId?: string;
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
  const [destChainId, setDestChainId] = useState(() => {
    const source = initialChainId ?? chains[0]?.chainId;
    if (initialDestChainId && initialDestChainId !== source && chains.some((c) => c.chainId === initialDestChainId)) {
      return initialDestChainId;
    }
    return chains.find((c) => c.chainId !== source)?.chainId ?? chains[1]?.chainId ?? "";
  });
  const [denom, setDenom] = useState(initialDenom ?? "");
  const [recipient, setRecipient] = useState("");
  /** Cross-chain To field stays closed until the user wants a different address. */
  const [toOpen, setToOpen] = useState(false);
  // The typed text belongs to the token and the exponent it was typed with: a
  // text read against another token, or against decimals that changed when
  // the balances were read again, reads as nothing rather than another amount.
  const [draft, setDraft] = useState<{ text: string; scale: string }>({ text: "", scale: "" });
  const [memo, setMemo] = useState("");
  const [manual, setManual] = useState<ManualChannel[]>([]);
  /** A route the user chose from the list, kept with the pair it was chosen for. */
  const [routeChoice, setRouteChoice] = useState<{ pair: string; key: string } | null>(null);
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
  const [reviewed, setReviewed] = useState<ReviewedSend | null>(null);
  /** The route being followed. Survives a popup close through storage. */
  const [tracked, setTracked] = useState<PendingTransfer | null>(null);
  /** Who the transfer just signed went to, for the save-contact offer. */
  const [sentTo, setSentTo] = useState("");
  /** Pinned channels the chains refused, already dropped from the preview once. */
  const droppedPins = useRef(new Set<string>());
  /** Why those channels were dropped, to say so while the route is shown. */
  const [refusedPins, setRefusedPins] = useState<readonly ChannelHopCheck[]>([]);

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
  const routePair = `${chain?.chainId ?? ""}>${destChain?.chainId ?? ""}`;
  const routeKey = routeChoice?.pair === routePair ? routeChoice.key : null;
  const selectedRoute =
    routeOptions.find((option) => option.key === routeKey) ?? routeOptions[0];
  const discovery = useAutoDiscovery(
    chain?.chainId ?? "",
    destChain?.chainId ?? "",
    cross && liveReads && channelReach.ready && Boolean(destChain),
    channelReach.reload,
  );

  const routePins = routePinsOf(selectedRoute);
  const effectiveManual = mergePins(routePins, manual);

  // Reachable networks first, fewest hops first; the rest keep their order.
  const destOptions = useMemo(() => {
    const hopsTo = (id: string) => channelReach.reach.get(id)?.hops.length ?? Infinity;
    return chains
      .filter((c) => c.chainId !== chain?.chainId)
      .map((c, index) => ({ c, index }))
      .sort((a, b) => hopsTo(a.c.chainId) - hopsTo(b.c.chainId) || a.index - b.index)
      .map(({ c }) => c);
  }, [chains, chain?.chainId, channelReach.reach]);

  const rows: SendToken[] = chain
    ? tokensOn(chain, balance).map((token) => ({
        token,
        identity: sendTokenIdentity(chain.chainId, token),
      }))
    : [];
  const selected = rows.find((row) => row.token.denom === denom) ?? rows[0];
  const token = selected?.token;
  const sendId = selected?.identity;
  const scale = sendId ? `${sendId.key}|${sendId.decimalsKnown ? sendId.decimals : "?"}` : "";
  const amount = draft.scale === scale ? draft.text : "";
  const setAmount = (text: string) => setDraft({ text, scale });
  const clearAmount = () => setDraft({ text: "", scale: "" });
  // Typed text is converted with the token's decimals; without them only Max,
  // the exact balance, can be used (lib/token-amount.ts).
  const maxOnly = sendId ? !canTypeAmount(sendId) : false;
  const available = token ? BigInt(token.amount) : null;
  const amountUnits = sendId ? toBaseUnits(amount, sendId.decimals) : null;
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
    const screenPins = routePins;
    const userPins = manual;
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
        if (controller.signal.aborted) return;
        setSettledPlan({ key: planKey, result: next });
        // The chains refused a channel this screen pinned only because its
        // preview showed that route. The refusal drops it from the channel
        // cache for this session, so reading the cache again previews (and
        // pins) another route instead of blocking on this one. A channel the
        // user entered stays theirs; a check that could not complete is
        // offered as a retry instead.
        const failed = next.best?.failedCheck ?? null;
        if (!failed || failed.verdict === "inconclusive") return;
        if (!pinnedByScreen(failed, screenPins, userPins)) return;
        const key = `${failed.sourceChainId}>${failed.destChainId}:${normalizeChannelId(failed.channelId)}`;
        if (droppedPins.current.has(key)) return;
        droppedPins.current.add(key);
        setRefusedPins((rows) => [...rows, failed]);
        channelReach.reload();
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
  // Why a route is gone: the checks that refused channels this screen had
  // pinned, and, with no route left, the planner's notes that name a channel
  // (each refusal names its channel; the summary is the button's reason).
  const refusals = [
    ...new Set([
      ...refusedPins
        .filter(
          (check) =>
            check.sourceChainId === chain?.chainId && check.destChainId === destChain?.chainId,
        )
        .map((check) => check.message),
      ...(!plan && !planning && !result?.error
        ? (result?.warnings.slice(1) ?? []).filter((note) => NAMES_A_CHANNEL.test(note))
        : []),
    ]),
  ];

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
  const previewHops = ((): RouteHopView[] => {
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
  })();

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

  const recipientState = ((): {
    tone: "default" | "error" | "valid";
    hint: string | undefined;
  } => {
    const value = recipient.trim();
    if (!value) {
      if (cross && destSelf) {
        return {
          tone: "valid",
          hint: destChain
            ? `This wallet on ${destChain.entry.chainName}`
            : "This wallet on the destination",
        };
      }
      return { tone: "default", hint: undefined };
    }
    if (!isBech32(value)) {
      return { tone: "error", hint: "Not a valid address. Check it for a typo." };
    }
    if (expectedPrefix && prefixOf(value) !== expectedPrefix) {
      return { tone: "error", hint: `Expected a ${expectedPrefix}1… address` };
    }
    if (chain && value === chain.address && !cross) {
      return { tone: "error", hint: "That is this wallet's address" };
    }
    const known = contacts.find((c) => c.address === value);
    return {
      tone: "valid",
      hint: known ? `Saved as ${known.label}` : "Valid address",
    };
  })();

  const blockedReason = ((): string | null => {
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
    if (!amount) {
      return maxOnly ? "Use Max to set the amount: this token's decimals are unknown." : null;
    }
    if (amountUnits === null) return "That amount is not a number this chain can hold.";
    if (amountUnits <= 0n) return "Enter an amount above zero.";
    if (overBalance) return `More than the ${sendId?.ticker ?? "balance"} available.`;
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
  })();

  const canReview =
    blockedReason === null &&
    recipientState.tone === "valid" &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    (!cross || Boolean(plan));

  function applyPercent(pct: number) {
    if (available === null || !sendId) return;
    const units = (maxSendable(available, feeReserve) * BigInt(pct)) / 100n;
    // Exact digits for any size: the field converts back with the same
    // exponent (0 when unknown), so Max signs the balance, not a rounding.
    setAmount(amountFieldText(units, sendId));
  }

  /* ---------------------------------------------------------------- *
   * Review and sign
   * ---------------------------------------------------------------- */

  async function review() {
    if (!chain || !token || !sendId || amountUnits === null) return;
    setError(null);
    const captured: ReviewedSend = {
      chainId: chain.chainId,
      denom: token.denom,
      identity: sendId,
      units: amountUnits,
    };
    if (!cross) {
      setReviewed(captured);
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
        // The default memo names the token as the signing chain holds it
        // (`IBC transfer USDC.n`, or no ticker for a token nothing proves).
        // The kernel keeps a memo it is given, so the preview carries the
        // memo that is shown and then signed.
        memo: resolveTxMemo("", msgs, chain.chainId),
        feeSpeed: settings.feeSpeed,
        gasAdjustment: settings.gasAdjustment,
      });
      setPendingMsgs(msgs);
      // Captured here, not at signing: this is the plan the confirm screen
      // describes, and it is the one tracking must follow afterwards.
      setReviewedPlan(plan);
      setReviewed(captured);
      setPreview(built);
      setPhase("confirm");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * New gas preferences on the review of a transfer: the reviewed plan, token
   * and amount, priced again (with a fresh timeout, as a new review would
   * have). They stay the ones reviewed even if the plan behind the form has
   * moved since: a discovery that ends while the review is open re-plans, and
   * may pick another channel, which a fee change must not slip in. No
   * preference is passed: GasFeePrefs saves the new ones before it calls
   * back, through a callback that still holds this render's old ones, and
   * the kernel reads the saved ones.
   */
  async function reprice() {
    if (!cross || !chain || !reviewed || !reviewedPlan || reviewed.chainId !== chain.chainId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const msgs = [
        buildTransferMsgFromPlan({
          view: reviewedPlan,
          sender: chain.address,
          amountBaseUnits: reviewed.units.toString(),
        }),
      ];
      const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
        chainId: chain.chainId,
        signerAddress: chain.address,
        msgs,
        memo: resolveTxMemo("", msgs, chain.chainId),
      });
      setPendingMsgs(msgs);
      setPreview(built);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

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

  /**
   * Sign what the confirm screen shows. `shownMemo` is the memo it displayed,
   * handed over as it is rather than worked out again here, so the memo on
   * chain is the one the user read.
   */
  async function confirmAndBroadcast(shownMemo: string) {
    if (!chain || !reviewed) return;
    // The review is bound to the chain it was made on. Should the network list
    // change under it (a chain removed in another window), the screen falls
    // back to another chain: nothing is signed there with this review's denom.
    if (reviewed.chainId !== chain.chainId) {
      setError("The network changed after this review. Go back and review the send again.");
      return;
    }
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
            memo: shownMemo,
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
            amountBaseUnits: reviewed.units.toString(),
            label: transferLabel(
              reviewed.units,
              reviewed.identity,
              chainNameOf(reviewedPlan.plan.destChainId),
            ),
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
        const msgs = sameChainMsgs(chain.address, recipient.trim(), reviewed);
        const broadcastResult = await signedSend<{ txhash: string }>(
          "SIGN_AND_BROADCAST",
          {
            chainId: chain.chainId,
            signerAddress: chain.address,
            msgs,
            memo: shownMemo,
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
      // The transfer just signed keeps the name and exponent it was reviewed
      // with; one resumed from an earlier popup is named from its plan.
      const moved =
        reviewed &&
        reviewed.chainId === tracked.plan.sourceChainId &&
        reviewed.denom === tracked.plan.inputDenom
          ? reviewed.identity
          : identityOf(tracked.plan.sourceChainId, tracked.plan.inputDenom);
      const movedAmount = amountParts(tracked.amountBaseUnits, moved);
      return (
        <ScreenScaffold
          title={failed ? "Transfer failed" : outcome === "delivered" ? "Transfer complete" : "Transfer in progress"}
          footer={<ResultFooter explorerUrl={explorerTxUrl(tracked.chainId, tracked.txHash)} onDone={onBack} />}
        >
          <div className="flex flex-col gap-2 pt-1">
            <TransferProgress
              amount={`${movedAmount.figure} ${movedAmount.unit}`}
              identity={moved}
              fromChainName={chainNameOf(tracked.plan.sourceChainId)}
              toChainName={chainNameOf(tracked.plan.destChainId)}
              route={route}
              loading={tracking.loading}
              error={tracking.error}
              onRefresh={tracking.refresh}
              txHash={tracked.txHash}
              sourceChainId={tracked.chainId}
              txUrl={explorerTxUrl}
            />
            {failed ? (
              <Callout compact tone="danger" title="Transaction failed">
                {route?.sourceError || "The source chain rejected this transfer. Nothing was sent."}
              </Callout>
            ) : outcome === "delivered" ? null : (
              <p className="px-0.5 text-[10.5px] leading-snug text-fg-dim">
                You can close this window: Zunia keeps following the transfer for a day and lists it in
                Activity.
              </p>
            )}
            {sentTo ? (
              <SaveContactPrompt
                address={sentTo}
                chainId={tracked.plan.destChainId}
                contacts={contacts}
                onSaved={() => onContactsChanged?.()}
              />
            ) : null}
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
    const sentAmount = reviewed ? amountParts(reviewed.units, reviewed.identity) : null;
    const explained = failed ? explainTxError(confirmed?.error ?? "") : null;
    return (
      <ScreenScaffold
        title={waiting ? "Sending" : failed ? "Send failed" : included ? "Sent" : "Send submitted"}
        onBack={onBack}
        footer={<ResultFooter explorerUrl={sentUrl} onDone={onBack} />}
      >
        <TxStatusHero
          status={waiting ? "pending" : failed ? "failed" : included ? "success" : "submitted"}
          title={waiting ? "Confirming" : failed ? "Not sent" : included ? "Sent" : "Broadcast accepted"}
          amount={
            reviewed && sentAmount ? (
              <>
                {sentAmount.figure}{" "}
                <span className="text-[14px] tracking-[-0.02em] text-fg-muted">{sentAmount.unit}</span>
              </>
            ) : null
          }
          line={sentTo ? `To ${truncateAddress(sentTo, 10, 8)} · on ${chain.entry.chainName}` : null}
          message={
            waiting
              ? `Waiting for ${chain.entry.chainName} to include it.`
              : explained
                ? explained.message
                : included
                  ? `Confirmed on ${chain.entry.chainName}.`
                  : `${chain.entry.chainName} has not confirmed it here yet. The explorer shows it as soon as it is in a block.`
          }
          errorDetail={explained?.detail ?? null}
          txHash={txHash}
        />
        {!waiting && sentTo ? (
          <div className="mt-4">
            <SaveContactPrompt
              address={sentTo}
              chainId={chain.chainId}
              contacts={contacts}
              onSaved={() => onContactsChanged?.()}
            />
          </div>
        ) : null}
      </ScreenScaffold>
    );
  }

  if (phase === "confirm" && reviewed) {
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
    const toAddress = effectiveRecipient;
    const toContact = contacts.find((contact) => contact.address === toAddress);
    const sent = reviewed.identity;
    const sentAmount = amountParts(reviewed.units, sent);
    const tag = networkTag(sent);
    // Shown below and handed to the signature as it is (the sign button).
    const shownMemo = cross
      ? transferMemo(preview, pendingMsgs, chain.chainId)
      : sameChainMemo(memo, chain.address, toAddress, reviewed);
    // What the recipient holds afterwards, from the plan that is signed.
    const arrival =
      cross && signedPlan
        ? sendArrival({
            sourceChainId: signedPlan.plan.sourceChainId,
            inputDenom: signedPlan.plan.inputDenom,
            destChainId: signedPlan.plan.destChainId,
            outputDenom: signedPlan.plan.outputDenom,
            warnings: signedPlan.warnings,
            links: signedPlan.candidate.links,
            sent,
          })
        : null;
    const toName = toContact?.label ?? (usingSelf ? "Your own address" : null);
    const destName = cross ? (destChain?.entry.chainName ?? "the destination") : chain.entry.chainName;
    const back = () => {
      setPhase("form");
      setError(null);
    };
    const rawMsgs = cross ? (pendingMsgs ?? []) : sameChainMsgs(chain.address, toAddress, reviewed);
    const rawFee = cross ? (preview?.fee ?? null) : localFee;
    return (
      <ScreenScaffold
        title={confirmTitle}
        onBack={back}
        footer={
          <ConfirmFooter
            busy={busy}
            action={signLabel}
            onBack={back}
            onSign={() => void confirmAndBroadcast(shownMemo)}
          />
        }
      >
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          <ReviewCard>
            <ReviewAmount
              label="You send"
              identity={sent}
              amount={
                <>
                  {sentAmount.figure}{" "}
                  <span className="text-[14px] tracking-[-0.02em] text-fg-muted">{sentAmount.unit}</span>
                </>
              }
              line={tokenLocationText(sent, "held")}
              srNote={provenanceLabel(sent)}
            />
            <ReviewArrow />
            <ReviewAmount
              label="To"
              avatar={
                <TokenLogo
                  src={cross ? destChain?.iconUrl : chain.iconUrl}
                  symbol={destName}
                  size={32}
                  verified={(cross ? destChain?.entry.inCosmosRegistry : chain.entry.inCosmosRegistry) ?? false}
                />
              }
              amount={
                toName ? (
                  <span className="text-[15px]">{toName}</span>
                ) : (
                  <span className="font-mono text-[14px] tracking-normal">{truncateAddress(toAddress, 10, 8)}</span>
                )
              }
              line={
                // The arrival text names the destination already (`USDC.n · Native on Noble`).
                arrival
                  ? `Arrives as ${arrival.text}`
                  : toName
                    ? `${truncateAddress(toAddress, 10, 8)} · on ${destName}`
                    : `On ${destName}`
              }
            />
            <ReviewFacts>
              {cross ? (
                <ReviewFact label="Route" note={forwarders.length > 0 ? `Forwarded by ${forwarders.join(", ")}` : null}>
                  {chain.entry.chainName} → {destName}
                </ReviewFact>
              ) : null}
              {cross && eta ? (
                <ReviewFact label="Arrives in">about {Math.max(1, Math.round(eta / 60))} min</ReviewFact>
              ) : null}
              {tag ? <ReviewFact label="Network">{tag}</ReviewFact> : null}
              <GasFeePrefs
                variant="fact"
                feeAmount={feeCoin?.amount}
                feeDecimals={chain.entry.feeDecimals}
                feeSymbol={feeTicker(chain.entry)}
                onChanged={() => {
                  if (cross) void reprice();
                }}
              />
              {cross && preview?.feeNote ? (
                <p className="text-right text-[10px] leading-snug text-fg-dim">{preview.feeNote}</p>
              ) : null}
            </ReviewFacts>
          </ReviewCard>

          {arrival?.warning ? (
            <Callout compact tone="warning" title={arrival.warning.title}>
              {arrival.warning.body}
            </Callout>
          ) : null}

          {unconfirmedPins.map((pin) => (
            <Callout
              compact
              key={`${pin.fromChainId}>${pin.toChainId}`}
              tone="warning"
              title={`${pin.channelId} was entered by hand`}
            >
              Nothing confirmed that it leads from {pin.fromChainId} to {pin.toChainId}. If it goes somewhere
              else, the funds can land on another chain or come back as a refund after the timeout.
            </Callout>
          ))}

          {error ? (
            <Callout compact tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : null}

          <ReviewDisclosure title="Transaction details" hint="addresses, denom, memo">
            <div className="divide-y divide-[var(--z-line)]">
              <PartyRow label="From" address={chain.address} hint="You" onCopy={copyParty} />
              <PartyRow
                label="To"
                address={toAddress}
                hint={
                  toContact?.label ??
                  (usingSelf ? `This wallet · ${destName}` : cross ? destName : undefined)
                }
                onCopy={copyParty}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <KeyValueRow
                label="Message"
                value={
                  confirmKind === "send" ? "MsgSend" : confirmKind === "ibc-forward" ? "MsgTransfer · PFM" : "MsgTransfer"
                }
              />
              <KeyValueRow label="Token" value={`${tokenKindLabel(sent.kind)} · ${issuerText(sent)}`} />
              {sent.kind !== "native" ? (
                <KeyValueRow
                  label="Denom"
                  value={<CopyDenom denom={reviewed.denom} what="Denom" onCopy={copyParty} />}
                />
              ) : null}
              {arrival ? (
                <KeyValueRow label="Arrives as" value={<ArrivalValue arrival={arrival} onCopy={copyParty} />} />
              ) : null}
              {cross && signedPlan ? (
                <KeyValueRow label="Channels" value={<WholeValue>{routeSentence(signedPlan.hops)}</WholeValue>} />
              ) : null}
              {cross ? (
                <KeyValueRow label="Timeout" value={<WholeValue>{timeoutLabel(pendingMsgs?.[0])}</WholeValue>} />
              ) : null}
              <KeyValueRow label="Memo" value={<WholeValue>{shownMemo}</WholeValue>} />
              {gas ? <KeyValueRow label="Gas" value={gas} /> : null}
            </div>
            {cross && memoInfo ? (
              <div className="min-w-0">
                <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                  What the packet memo will do
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-fg">{memoInfo.summary}</p>
                {memoInfo.warnings.map((warning) => (
                  <p key={warning} className="mt-1 text-[10.5px] text-[var(--z-warning)]">
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
            <p className="text-[10.5px] leading-snug text-fg-dim">
              {cross
                ? `You pay gas only on ${chain.entry.chainName}, in ${feeTicker(chain.entry)}. Relayers carry the packet the rest of the way.`
                : `This stays on ${chain.entry.chainName}: the recipient can spend it as soon as the transaction is included.`}
            </p>
          </ReviewDisclosure>
          <RawTxDisclosure
            json={rawTxJson({ chainId: chain.chainId, memo: shownMemo, fee: rawFee, messages: rawMsgs })}
          />
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
            setReviewed(null);
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
            clearAmount();
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
            <p className="shrink-0 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.16em] text-fg-muted">
              You send
            </p>
            {/* Wrapped, never cut: a balance in base units can run to 25 digits. */}
            <p className="min-w-0 text-right font-mono text-[10px] tabular-nums text-fg-dim [overflow-wrap:anywhere]">
              {hidden
                ? "••••"
                : token && sendId
                  ? `${formatTokenAmount(token.amount, sendId, "picker")} available`
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
              readOnly={maxOnly}
              aria-describedby={maxOnly ? "send-amount-note" : undefined}
              onChange={(e) => setAmount(decimalText(e.target.value))}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-left text-[26px] font-semibold leading-none tracking-[-0.04em] tabular-nums outline-none",
                "placeholder:text-fg-faint",
                maxOnly ? "text-fg-muted" : "text-fg",
              )}
            />
            <TokenPicker
              chainId={chain.chainId}
              rows={rows}
              selected={selected}
              hidden={hidden}
              onSelect={(next) => {
                setDenom(next.token.denom);
                clearAmount();
                setManual([]);
              }}
            />
          </div>
          {maxOnly ? (
            <p id="send-amount-note" className="mt-2 text-[10.5px] leading-snug text-fg-muted">
              {MAX_ONLY_NOTE}
            </p>
          ) : null}
          <div className="mt-2.5 flex gap-1">
            {PERCENTS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={available === null || (maxOnly && pct !== 100)}
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
              warnings={
                plan ? routeNotes(plan.warnings, routePins, manual) : (result?.warnings ?? [])
              }
              requiresPfm={plan?.plan.requiresPfm ?? false}
              gasChainName={chain.entry.chainName}
              loading={planning && !plan}
              error={result?.error ?? null}
              onRetry={() => setRetryToken((n) => n + 1)}
              footer={
                plan ? (
                  <div className="flex flex-col gap-2">
                    {refusals.map((reason) => (
                      <p
                        key={reason}
                        className="text-[10.5px] leading-snug text-[var(--z-warning-fg)] [overflow-wrap:anywhere]"
                      >
                        {reason}
                      </p>
                    ))}
                    {plan.failedCheck?.verdict === "inconclusive" ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="self-start"
                        onClick={() => setRetryToken((n) => n + 1)}
                      >
                        Check again
                      </Button>
                    ) : null}
                    <RouteChoiceList
                      options={routeOptions}
                      selectedKey={selectedRoute?.key ?? ""}
                      onSelect={(key) => setRouteChoice({ pair: routePair, key })}
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
                onSelect={(key) => setRouteChoice({ pair: routePair, key })}
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
              {refusals.map((reason) => (
                <p
                  key={reason}
                  className="text-[10.5px] leading-snug text-[var(--z-warning-fg)] [overflow-wrap:anywhere]"
                >
                  {reason}
                </p>
              ))}
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
