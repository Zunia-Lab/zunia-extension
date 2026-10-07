/**
 * One NFT: what it is, and moving it.
 *
 * The transfer half is the reason this screen exists rather than a sheet. A
 * CW721 transfer reaches the chain as a `MsgExecuteContract`, which every naive
 * wallet renders as "Execute contract" - a description that does not say which
 * token is leaving, from which collection, or to whom. So the confirm phase
 * decodes the message it is about to sign and states those three facts, and it
 * refuses to describe a message it could not decode.
 *
 * Two destinations, with very different consequences:
 *
 * - Same chain: a `transfer_nft`. The recipient owns the token afterwards.
 * - Another chain: an ICS721 `send_nft` to a cw-ics721 bridge. The original is
 *   escrowed here and the far side mints a debt voucher, which is not the same
 *   asset. That is said before signing, not after.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Input,
  KeyValueRow,
  NftDetail,
  ScreenScaffold,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
  type NftTrait,
} from "@zunialab/ui";
import type { BuiltMsg, IbcChannelOption } from "@zunialab/interchain";

import { explorerTxUrl } from "../../../config/interchain";
import type { AddressBookEntry } from "../../../lib/address-book";
import { feeTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import { isBech32, prefixOf } from "../../../lib/format";
import { describeInterchainError } from "../../../lib/interchain";
import {
  buildCrossChainNftTransfer,
  buildSameChainNftTransfer,
  crossChainWarnings,
  discoverIcs721Channels,
  ics721Port,
  loadCollection,
  loadToken,
  mediaTargetFor,
  nftChainSupport,
  validateIcs721Channel,
  type NftCollection,
  type NftTokenView,
} from "../../../lib/nft";
import { sendToBackground } from "../../../lib/popup-client";
import type { TxPreview } from "../../../lib/tx-kernel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { ChainSheet, PickerTrigger } from "../components/ChainSheet";
import { ContactChips } from "../components/AddressFieldExtras";
import { useKernelSigning } from "./interchain-ui";
import {
  BridgeOverride,
  NftDisabledReason,
  NftExecutePanel,
  useNftBridge,
  useNftChains,
  useNftMediaGate,
} from "./nft-ui";
import { GasFeePrefs } from "../components/GasFeePrefs";
import {
  ConfirmFooter,
  ExactMessages,
  RawTxDisclosure,
  ResultFooter,
  ReviewAmount,
  ReviewArrow,
  ReviewCard,
  ReviewDisclosure,
  ReviewFacts,
  TxStatusHero,
  explainTxError,
  rawTxJson,
} from "../components/TxReview";
import { useTxDetail } from "../hooks/useChainQuery";
import { IconNft } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";

type Phase = "view" | "transfer" | "confirm" | "sent";
type Destination = "same" | "cross";

/** What the confirm phase is about to sign. */
interface PendingNftTx {
  readonly msg: BuiltMsg;
  readonly chainId: string;
  readonly signerAddress: string;
  readonly destination: Destination;
  readonly destChainName: string | null;
  /** The verified bridge a cross-chain message was built for; null for a same-chain one. */
  readonly bridgeContract: string | null;
  readonly title: string;
}

export function NftDetailScreen({
  chainId,
  collectionAddress,
  tokenId,
  chains,
  contacts,
  onContactsChanged,
  onBack,
}: {
  chainId: string;
  collectionAddress: string;
  tokenId: string;
  chains: readonly ChainAccountView[];
  contacts: readonly AddressBookEntry[];
  onContactsChanged?: () => void;
  onBack: () => void;
}) {
  const signedSend = useSignedSend();
  const media = useNftMediaGate();
  const kernel = useKernelSigning();
  const { supported } = useNftChains(chains);

  const chain = chains.find((row) => row.chainId === chainId) ?? null;
  const entry = chain?.entry ?? findCatalogEntry(chainId);
  const owner = chain?.address ?? "";
  // Memoised because it is a dependency of `blockedReason`: a fresh object per
  // render would make that memo recompute on every render for no reason.
  const support = useMemo(() => nftChainSupport(chainId), [chainId]);

  const [phase, setPhase] = useState<Phase>("view");
  const [reloadToken, setReloadToken] = useState(0);

  /* ------------------------------------------------------------------ *
   * The token
   * ------------------------------------------------------------------ */

  const requestKey = `${chainId}:${collectionAddress}:${tokenId}:${media.enabled}:${reloadToken}`;
  const [settled, setSettled] = useState<{
    requestKey: string;
    view: NftTokenView | null;
    collection: NftCollection | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!support.supported) return;
    const controller = new AbortController();
    void (async () => {
      // The collection read is best-effort: a contract that answers neither
      // `collection_info` nor `contract_info` still has tokens, and losing the
      // name is not a reason to hide the token the user asked for.
      const collection = await loadCollection(chainId, collectionAddress, {
        signal: controller.signal,
      }).catch(() => null);
      try {
        const view = await loadToken(chainId, collectionAddress, tokenId, {
          withOffChainMetadata: media.enabled,
          collectionName: collection?.name ?? null,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setSettled({ requestKey, view, collection, error: null });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setSettled({
          requestKey,
          view: null,
          collection,
          error: describeInterchainError(error),
        });
      }
    })();
    return () => controller.abort();
    // `requestKey` carries every input; listing them again would re-run on the
    // same values.
  }, [requestKey, chainId, collectionAddress, tokenId, media.enabled, support.supported]);

  const current = settled?.requestKey === requestKey ? settled : null;
  const view = current?.view ?? null;
  const collection = current?.collection ?? null;
  const token = view?.token ?? null;
  const loading = support.supported && current === null;

  const collectionName = collection?.name ?? null;
  const image = media.enabled ? mediaTargetFor(token?.imageUri).url : null;
  const traits: NftTrait[] = (token?.attributes ?? []).map((attribute) => ({
    traitType: attribute.traitType,
    value: attribute.value,
    displayType: attribute.displayType,
  }));

  /* ------------------------------------------------------------------ *
   * Transfer form
   * ------------------------------------------------------------------ */

  const [destination, setDestination] = useState<Destination>("same");
  const [recipient, setRecipient] = useState("");
  const [destChainId, setDestChainId] = useState<string | null>(null);
  const [destPickerOpen, setDestPickerOpen] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [channelNote, setChannelNote] = useState<string | null>(null);
  const [channelChecking, setChannelChecking] = useState(false);
  const [pending, setPending] = useState<PendingNftTx | null>(null);
  const [preview, setPreview] = useState<TxPreview | null>(null);
  /**
   * The broadcast result, not just its hash.
   *
   * `sync` broadcast returns the node's CheckTx verdict, so a rejected
   * transaction is knowable immediately and must not be drawn as a success.
   * A zero code still only means "accepted into the mempool" - inclusion in a
   * block is a later, separate fact this screen does not have.
   */
  const [sent, setSent] = useState<{
    txhash: string;
    code: number;
    rawLog: string;
    success: boolean;
  } | null>(null);
  // A transaction the node accepted is followed until a block includes it,
  // so the result says "Sent" only once it is, and why not when it is not.
  const inclusion = useTxDetail(
    chainId,
    phase === "sent" && sent?.success ? sent.txhash : "",
    phase === "sent" && Boolean(sent?.success),
    { intervalMs: 2_000, maxRetries: 60 },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cross = destination === "cross";
  const bridge = useNftBridge(chainId, cross);
  const bridgeContract = bridge.check?.contractAddress ?? null;
  const bridgeReady = Boolean(bridge.check?.verifiedAt && bridgeContract);

  const destChains = useMemo(
    () => supported.filter((row) => row.chainId !== chainId),
    [supported, chainId],
  );
  const destChain = destChains.find((row) => row.chainId === destChainId) ?? null;

  /**
   * Open ICS721 channels, discovered on the bridge's own port.
   *
   * cw-ics721 binds `wasm.<contract>`, not `transfer`, so a search on the
   * transfer port returns ICS20 channels - which would look right, pass a
   * naive check and send the NFT nowhere.
   *
   * Keyed by the request rather than cleared in the effect: `channelOptions`
   * is derived from which request the screen should be showing, so switching
   * destination cannot leave the previous chain's channels on screen for a
   * render.
   */
  const channelKey =
    cross && bridgeReady && bridgeContract && destChainId
      ? `${chainId}:${destChainId}:${bridgeContract}`
      : "";
  const [channelSettled, setChannelSettled] = useState<{
    channelKey: string;
    options: readonly IbcChannelOption[];
  } | null>(null);

  useEffect(() => {
    if (!channelKey || !destChainId || !bridgeContract) return;
    const controller = new AbortController();
    void discoverIcs721Channels(chainId, destChainId, bridgeContract, {
      signal: controller.signal,
    })
      .then((options) => {
        if (controller.signal.aborted) return;
        setChannelSettled({ channelKey, options });
        const first = options[0];
        // Functional update so this does not have to depend on the field the
        // user is typing into, and so a typed value is never overwritten.
        if (first) setChannelId((prev) => (prev.length === 0 ? first.channelId : prev));
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setChannelSettled({ channelKey, options: [] });
        setChannelNote(describeInterchainError(caught));
      });
    return () => controller.abort();
  }, [channelKey, chainId, destChainId, bridgeContract]);

  const channelOptions =
    channelSettled?.channelKey === channelKey ? channelSettled.options : null;

  const checkChannel = useCallback(async () => {
    if (!bridgeContract || channelId.trim().length === 0) return;
    setChannelChecking(true);
    setChannelNote(null);
    try {
      const result = await validateIcs721Channel(
        chainId,
        channelId.trim(),
        destChainId ?? undefined,
        bridgeContract,
      );
      setChannelNote(
        result.counterparty ? `${result.message} ${result.counterparty.message}` : result.message,
      );
    } catch (caught) {
      setChannelNote(describeInterchainError(caught));
    } finally {
      setChannelChecking(false);
    }
  }, [bridgeContract, channelId, chainId, destChainId]);

  const expectedPrefix = cross
    ? destChain?.entry.bech32Prefix
    : entry?.bech32Prefix;

  const recipientState = useMemo(() => {
    const value = recipient.trim();
    if (!value) return { tone: "default" as const, hint: undefined };
    if (!isBech32(value)) {
      return { tone: "error" as const, hint: "Not a valid address. Check it for a typo." };
    }
    if (expectedPrefix && prefixOf(value) !== expectedPrefix) {
      return {
        tone: "error" as const,
        hint: `Expected a ${expectedPrefix}1… address. Sending an NFT to an address on the wrong chain loses it.`,
      };
    }
    if (!cross && value === owner) {
      return { tone: "error" as const, hint: "That is this wallet's address" };
    }
    const known = contacts.find((c) => c.address === value);
    return {
      tone: "valid" as const,
      hint: known ? `Saved as ${known.label}` : "Valid address",
    };
  }, [recipient, expectedPrefix, cross, owner, contacts]);

  /**
   * Ownership, as the chain reports it.
   *
   * `owner_of` is read with the token, so this is chain state and not an
   * assumption from the discovery list. A token the wallet does not own cannot
   * be transferred by it, and saying so up front beats a rejected transaction.
   */
  const ownsToken = token?.owner !== null && token?.owner === owner;

  const blockedReason = useMemo((): string | null => {
    if (!support.supported) return support.reason;
    if (!chain || owner.length === 0) {
      return `Zunia has no ${entry?.chainName ?? chainId} address for this wallet, so it cannot sign a transfer.`;
    }
    if (kernel.loading) return null;
    if (kernel.reason) return kernel.reason;
    if (!token) return "The token has not been read yet.";
    if (token.owner === null) {
      return "This contract did not answer who owns the token, so Zunia will not offer to move it.";
    }
    if (!ownsToken) {
      return `This token is owned by ${truncateAddress(token.owner, 8, 6)}, not by this wallet.`;
    }
    if (recipientState.tone !== "valid") return null;
    if (!cross) return null;
    if (bridge.loading) return null;
    if (!bridgeReady) return bridge.check?.reason ?? "The bridge contract has not been checked yet.";
    if (!destChain) return "Pick a destination network.";
    if (channelId.trim().length === 0) {
      return channelOptions !== null && channelOptions.length === 0
        ? `No open ICS721 channel was found on ${ics721Port(bridgeContract ?? "")}. Enter one by hand if you know it.`
        : "Pick or enter the ICS721 channel.";
    }
    return null;
  }, [
    support,
    chain,
    owner,
    entry,
    chainId,
    kernel.loading,
    kernel.reason,
    token,
    ownsToken,
    recipientState.tone,
    cross,
    bridge.loading,
    bridge.check,
    bridgeReady,
    bridgeContract,
    destChain,
    channelId,
    channelOptions,
  ]);

  const canReview =
    blockedReason === null && recipientState.tone === "valid" && Boolean(token);

  /* ------------------------------------------------------------------ *
   * Build, preview, sign
   * ------------------------------------------------------------------ */

  async function review() {
    if (!token || !chain) return;
    setBusy(true);
    setError(null);
    try {
      // Narrowed rather than asserted. `canReview` already covers both, but a
      // `!` here would turn a future regression in that predicate into a
      // TypeError over a transaction instead of a sentence.
      if (cross && (!destChain || !bridgeContract)) {
        throw new Error(
          "A destination chain and a verified bridge contract are both needed before this can be built.",
        );
      }
      const msg =
        cross && destChain && bridgeContract
          ? buildCrossChainNftTransfer({
              chainId,
              destChainId: destChain.chainId,
              sender: owner,
              collectionAddress,
              tokenId,
              recipient: recipient.trim(),
              bridgeContract,
              channelId: channelId.trim(),
            })
          : buildSameChainNftTransfer({
              chainId,
              sender: owner,
              collectionAddress,
              tokenId,
              recipient: recipient.trim(),
            });
      // No fee preferences here: the worker reads the saved ones, so a fee
      // changed on the confirm screen re-previews at the new speed.
      const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
        chainId,
        signerAddress: owner,
        msgs: [msg],
      });
      setPending({
        msg,
        chainId,
        signerAddress: owner,
        destination,
        destChainName: destChain?.entry.chainName ?? null,
        bridgeContract: cross ? bridgeContract : null,
        title: cross ? "Send NFT to another chain" : "Transfer NFT",
      });
      setPreview(built);
      setPhase("confirm");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!pending || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signedSend<{
        txhash: string;
        code: number;
        rawLog: string;
        success: boolean;
      }>("SIGN_AND_BROADCAST_TX", {
        chainId: pending.chainId,
        signerAddress: pending.signerAddress,
        msgs: [pending.msg],
        memo: preview.preview.memo,
        fee: preview.fee,
        accountNumber: preview.accountNumber,
        sequence: preview.sequence,
        expectSignBytesHash: preview.preview.signBytesHash,
      });
      setSent(result);
      setPhase("sent");
      const to = recipient.trim();
      if (contacts.some((contact) => contact.address === to)) {
        void sendToBackground("TOUCH_ADDRESS_BOOK_ENTRY", { address: to })
          .then(() => onContactsChanged?.())
          .catch(() => undefined);
      }
    } catch (caught) {
      setError(signingError(caught));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * Confirm
   * ------------------------------------------------------------------ */

  if (phase === "confirm" && pending && preview) {
    const feeCoin = preview.fee.amount[0];
    const warnings =
      pending.destination === "cross" && destChain && bridgeContract
        ? crossChainWarnings({
            chainId,
            destChainId: destChain.chainId,
            bridgeContract,
            channelId: channelId.trim(),
            collectionAddress,
            tokenId,
            sender: owner,
            recipient: recipient.trim(),
          })
        : [];
    const back = () => {
      setPhase("transfer");
      setError(null);
    };
    const to = recipient.trim();
    const destName =
      pending.destination === "cross" ? (pending.destChainName ?? "the destination") : (entry?.chainName ?? chainId);
    return (
      <ScreenScaffold
        title={pending.title}
        onBack={back}
        footer={<ConfirmFooter busy={busy} onBack={back} onSign={() => void sign()} />}
      >
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          <ReviewCard>
            <ReviewAmount
              label="You send"
              avatar={
                image ? (
                  <img
                    src={image}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="size-8 shrink-0 rounded-[8px] border border-[var(--z-line)] object-cover"
                  />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--z-line)] text-fg-muted">
                    <IconNft width={16} height={16} aria-hidden />
                  </span>
                )
              }
              amount={<span className="text-[15px]">{token?.name ?? `#${tokenId}`}</span>}
              line={`${collectionName ?? truncateAddress(collectionAddress, 10, 6)} · on ${entry?.chainName ?? chainId}`}
            />
            <ReviewArrow />
            <ReviewAmount
              label="To"
              amount={<span className="font-mono text-[14px] tracking-normal">{truncateAddress(to, 10, 8)}</span>}
              line={pending.destination === "cross" ? `On ${destName}, as a voucher of this NFT` : `On ${destName}`}
            />
            <ReviewFacts>
              <GasFeePrefs
                variant="fact"
                feeAmount={feeCoin?.amount}
                feeDecimals={entry?.feeDecimals ?? 6}
                feeSymbol={entry ? feeTicker(entry) : (feeCoin?.denom ?? "")}
                onChanged={() => {
                  void review();
                }}
              />
              {preview.feeNote ? (
                <p className="text-right text-[10px] leading-snug text-fg-dim">{preview.feeNote}</p>
              ) : null}
            </ReviewFacts>
          </ReviewCard>

          {warnings.length > 0 ? (
            <Callout compact tone="warning" title="What the destination receives">
              <ul className="flex flex-col gap-1">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {error ? (
            <Callout compact tone="danger" title="Could not sign">
              {error}
            </Callout>
          ) : null}

          <ReviewDisclosure title="Transaction details" hint="contract, message, memo">
            {/* The decoded call and the kernel's own reading of it, side by side:
                if the two ever disagree, the difference is visible. */}
            <NftExecutePanel
              msg={pending.msg}
              collectionName={collectionName}
              tokenName={token?.name ?? null}
              destChainName={pending.destChainName}
              bridgeContract={pending.bridgeContract}
            />
            <ExactMessages summaries={preview.preview.summaries} memo={preview.preview.memo} />
            <KeyValueRow label="Gas" value={preview.fee.gas_limit} />
            <KeyValueRow label="Sign bytes" value={`${preview.preview.signBytesHash.slice(0, 12)}…`} />
          </ReviewDisclosure>
          <RawTxDisclosure
            json={rawTxJson({ chainId, memo: preview.preview.memo, fee: preview.fee, messages: [pending.msg] })}
          />
        </div>
      </ScreenScaffold>
    );
  }

  /* ------------------------------------------------------------------ *
   * Sent
   * ------------------------------------------------------------------ */

  if (phase === "sent" && sent) {
    const txHash = sent.txhash;
    const url = explorerTxUrl(chainId, txHash);
    const wasCross = pending?.destination === "cross";
    const confirmed = sent.success ? inclusion.detail : null;
    const waiting = sent.success && !confirmed && (inclusion.retrying || inclusion.loading || inclusion.missing);
    const failed = !sent.success || Boolean(confirmed && !confirmed.success);
    const included = Boolean(confirmed?.success);
    const chainLabel = entry?.chainName ?? chainId;
    const explained = confirmed && !confirmed.success ? explainTxError(confirmed.error ?? "") : null;
    return (
      <ScreenScaffold
        title={failed ? "NFT not sent" : included ? "NFT sent" : "Sending NFT"}
        footer={<ResultFooter explorerUrl={url} onDone={onBack} />}
      >
        <TxStatusHero
          status={failed ? "failed" : included ? "success" : waiting ? "pending" : "submitted"}
          title={failed ? "Not sent" : included ? "Sent" : waiting ? "Confirming" : "Broadcast accepted"}
          amount={<span className="text-[17px]">{token?.name ?? `#${tokenId}`}</span>}
          line={`To ${truncateAddress(recipient.trim(), 10, 8)}${wasCross ? ` · on ${pending?.destChainName ?? "the destination"}` : ""}`}
          message={
            !sent.success
              ? `The node rejected it, so nothing moved (code ${sent.code}${sent.rawLog ? `: ${sent.rawLog}` : ""}).`
              : explained
                ? explained.message
                : included
                  ? wasCross
                    ? `The bridge on ${chainLabel} holds the NFT; a voucher is minted on ${pending?.destChainName ?? "the destination"} once a relayer delivers it.`
                    : "It belongs to the recipient now."
                  : waiting
                    ? `Waiting for ${chainLabel} to include it.`
                    : "Not confirmed here yet. The explorer shows it as soon as it is in a block."
          }
          errorDetail={explained?.detail ?? null}
          txHash={txHash}
        />
      </ScreenScaffold>
    );
  }

  /* ------------------------------------------------------------------ *
   * Transfer form
   * ------------------------------------------------------------------ */

  if (phase === "transfer") {
    return (
      <ScreenScaffold
        title="Move this NFT"
        onBack={() => {
          setPhase("view");
          setError(null);
        }}
        footer={
          <>
            <Button
              className="w-full"
              disabled={!canReview || busy}
              onClick={() => void review()}
            >
              {busy ? "Preparing…" : "Review transfer"}
            </Button>
            <NftDisabledReason reason={blockedReason} />
          </>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-2.5">
            <p className="m-0 truncate text-[12.5px] font-medium text-fg">
              {token?.name ?? `#${tokenId}`}
            </p>
            <p className="m-0 mt-0.5 truncate font-mono text-[9px] text-fg-dim">
              {collectionName ?? truncateAddress(collectionAddress, 8, 6)} ·{" "}
              {entry?.chainName ?? chainId}
            </p>
          </section>

          {/* Two destinations, as two buttons rather than a segmented control:
              they do genuinely different things and the cross-chain one has a
              consequence that needs a sentence under it. */}
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Where to
            </legend>
            {(
              [
                {
                  id: "same" as const,
                  label: `Someone on ${entry?.chainName ?? chainId}`,
                  note: "A CW721 transfer. The recipient owns the token afterwards.",
                },
                {
                  id: "cross" as const,
                  label: "Another chain",
                  note: "ICS721. The original is escrowed here and the far side mints a voucher, which is not the same asset.",
                },
              ]
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={destination === option.id}
                onClick={() => {
                  setDestination(option.id);
                  setError(null);
                }}
                className={cn(
                  "rounded-[13px] border px-3 py-2 text-left",
                  destination === option.id
                    ? "border-[var(--z-accent)] bg-[var(--z-state-selected)]"
                    : "border-[var(--z-line)] hover:bg-[var(--z-state-hover)]",
                  focusRing,
                )}
              >
                <span className="block text-[11.5px] text-fg">{option.label}</span>
                <span className="mt-0.5 block text-[10px] leading-snug text-fg-muted">
                  {option.note}
                </span>
              </button>
            ))}
          </fieldset>

          {cross ? (
            <section className="flex flex-col gap-2">
              <PickerTrigger
                className="rounded-[13px] py-2"
                expanded={destPickerOpen}
                disabled={destChains.length === 0}
                onClick={() => setDestPickerOpen(true)}
                title={
                  destChain?.entry.chainName ??
                  (destChains.length === 0
                    ? "No other CosmWasm network is enabled"
                    : "Pick a destination network")
                }
              />
              <ChainSheet
                open={destPickerOpen}
                onClose={() => setDestPickerOpen(false)}
                title="Destination network"
                chains={destChains}
                selectedId={destChainId ?? undefined}
                onSelect={(id) => {
                  setDestChainId(id);
                  setChannelId("");
                  setChannelNote(null);
                }}
              />

              {/* The bridge is host configuration and ships unset, so this is
                  the state most users will see. It names the missing piece
                  rather than showing a control that can never work. */}
              {bridge.loading ? (
                <p className="m-0 flex items-center gap-1.5 text-[10.5px] text-fg-dim">
                  <Spinner /> Checking the bridge contract…
                </p>
              ) : bridgeReady ? (
                <p className="m-0 text-[10px] leading-snug text-fg-muted">
                  Bridge {truncateAddress(bridgeContract ?? "", 8, 6)}
                  {bridge.check?.label ? ` · ${bridge.check.label}` : ""} verified on{" "}
                  {entry?.chainName ?? chainId}.
                </p>
              ) : (
                <Callout tone="warning" title="No verified bridge contract">
                  {bridge.check?.reason ??
                    "The cw-ics721 bridge for this chain has not been checked."}
                  <BridgeOverride
                    chainId={chainId}
                    current={bridgeContract}
                    onSaved={bridge.recheck}
                  />
                </Callout>
              )}

              {bridgeReady && destChainId ? (
                <div className="flex flex-col gap-1.5">
                  <Input
                    label="ICS721 channel"
                    placeholder="channel-…"
                    value={channelId}
                    spellCheck={false}
                    autoComplete="off"
                    hint={
                      channelOptions === null
                        ? `Looking for open channels on ${ics721Port(bridgeContract ?? "")}…`
                        : channelOptions.length > 0
                          ? `${channelOptions.length} open channel${channelOptions.length === 1 ? "" : "s"} found on the bridge's own port.`
                          : "None found. NFT channels live on the bridge's port, not on transfer, so an ICS20 channel id will not work here."
                    }
                    onChange={(event) => {
                      setChannelId(event.target.value);
                      setChannelNote(null);
                    }}
                  />
                  {channelOptions && channelOptions.length > 0 ? (
                    <ul className="flex flex-wrap gap-1.5">
                      {channelOptions.slice(0, 4).map((option) => (
                        <li key={option.channelId}>
                          <button
                            type="button"
                            onClick={() => setChannelId(option.channelId)}
                            className={cn(
                              "rounded-full border border-[var(--z-line)] px-2.5 py-1 font-mono text-[9.5px] text-fg-muted hover:text-fg",
                              focusRing,
                            )}
                          >
                            {option.channelId}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={channelChecking || channelId.trim().length === 0}
                      onClick={() => void checkChannel()}
                    >
                      {channelChecking ? "Checking…" : "Check this channel"}
                    </Button>
                  </div>
                  {channelNote ? (
                    <p className="m-0 text-[10px] leading-snug text-fg-muted">{channelNote}</p>
                  ) : (
                    <p className="m-0 text-[10px] leading-snug text-fg-muted">
                      A channel Zunia has not checked is shown as unchecked.
                      Checking reads both ends of the channel; it does not prove
                      the far side runs a bridge that will mint anything, which
                      only the destination chain can answer.
                    </p>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          <section>
            {/* The field carries its own `label`, so the accessible name comes
                from a real <label for> rather than from a heading above it that
                nothing is associated with. */}
            <Input
              label="Recipient"
              placeholder={`${expectedPrefix ?? "cosmos"}1…`}
              value={recipient}
              spellCheck={false}
              autoComplete="off"
              state={recipientState.tone}
              hint={recipientState.hint}
              onChange={(event) => setRecipient(event.target.value)}
            />
            {!recipient ? (
              <ContactChips
                contacts={contacts}
                expectedPrefix={expectedPrefix}
                expectedChainId={cross ? destChain?.chainId : chainId}
                onPick={setRecipient}
              />
            ) : null}
          </section>

          {error ? (
            <Callout tone="danger" title="Could not prepare this transfer">
              {error}
            </Callout>
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

  /* ------------------------------------------------------------------ *
   * View
   * ------------------------------------------------------------------ */

  if (!support.supported) {
    return (
      <ScreenScaffold title="NFT" onBack={onBack}>
        <div className="pt-3">
          <Callout tone="neutral" title="NFTs are not available on this chain" />
        </div>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title={collectionName ?? "NFT"}
      onBack={onBack}
      footer={
        <>
          <Button
            className="w-full"
            disabled={!token || Boolean(blockedReason) || kernel.loading}
            onClick={() => {
              setPhase("transfer");
              setError(null);
            }}
          >
            Move this NFT
          </Button>
          {/* While the token is still being read there is nothing to say; once
              it has settled, the reason the button is off is stated - including
              "this wallet does not own it", which is the common one. */}
          <NftDisabledReason reason={loading ? null : blockedReason} />
        </>
      }
    >
      <div className="pt-1">
        <NftDetail
          tokenId={tokenId}
          name={token?.name ?? null}
          collectionAddress={collectionAddress}
          collectionName={collectionName}
          chainId={chainId}
          imageUrl={image}
          description={token?.description ?? null}
          owner={token?.owner ?? null}
          traits={traits}
          loadMedia={media.enabled && !loading}
          tokenUri={token?.tokenUri ?? null}
          loading={loading}
          error={current?.error ?? null}
          actions={
            <div className="flex w-full flex-col gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => setReloadToken((n) => n + 1)}
              >
                Reload from chain
              </Button>
            </div>
          }
        />
      </div>
    </ScreenScaffold>
  );
}
