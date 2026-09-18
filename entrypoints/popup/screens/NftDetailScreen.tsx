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
  SectionLabel,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
  type NftTrait,
} from "@zunialab/ui";
import type { BuiltMsg, IbcChannelOption } from "@zunialab/interchain";

import { explorerTxUrl } from "../../../config/interchain";
import type { AddressBookEntry } from "../../../lib/address-book";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { formatUnits, isBech32, prefixOf } from "../../../lib/format";
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
import { OverlayMenu, OverlayMenuItem } from "../components/OverlayMenu";
import { useKernelSigning } from "./interchain-ui";
import {
  BridgeOverride,
  NftDisabledReason,
  NftExecutePanel,
  useNftBridge,
  useNftChains,
  useNftMediaGate,
} from "./nft-ui";
import { IconChevronDown } from "./icons";

type Phase = "view" | "transfer" | "confirm" | "sent";
type Destination = "same" | "cross";

/** What the confirm phase is about to sign. */
interface PendingNftTx {
  readonly msg: BuiltMsg;
  readonly chainId: string;
  readonly signerAddress: string;
  readonly destination: Destination;
  readonly destChainName: string | null;
  readonly title: string;
}

export function NftDetailScreen({
  chainId,
  collectionAddress,
  tokenId,
  chains,
  contacts,
  onBack,
}: {
  chainId: string;
  collectionAddress: string;
  tokenId: string;
  chains: readonly ChainAccountView[];
  contacts: readonly AddressBookEntry[];
  onBack: () => void;
}) {
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
      return { tone: "error" as const, hint: "Not a valid bech32 address" };
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
      const result = await sendToBackground<{
        txhash: string;
        code: number;
        rawLog: string;
        success: boolean;
      }>("SIGN_AND_BROADCAST_TX", {
        chainId: pending.chainId,
        signerAddress: pending.signerAddress,
        msgs: [pending.msg],
        fee: preview.fee,
        accountNumber: preview.accountNumber,
        sequence: preview.sequence,
        expectSignBytesHash: preview.preview.signBytesHash,
      });
      setSent(result);
      setPhase("sent");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
    return (
      <ScreenScaffold
        title={pending.title}
        onBack={() => {
          setPhase("transfer");
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => {
                setPhase("transfer");
                setError(null);
              }}
            >
              Back
            </Button>
            <Button className="flex-1" disabled={busy} onClick={() => void sign()}>
              {busy ? "Signing…" : "Sign and send"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <NftExecutePanel
            msg={pending.msg}
            collectionName={collectionName}
            tokenName={token?.name ?? null}
            destChainName={pending.destChainName}
          />

          {warnings.length > 0 ? (
            <Callout tone="warning" title="What the destination receives">
              <ul className="flex flex-col gap-1">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          {/* The kernel's own reading of the transaction, kept alongside the
              decoded panel. If the two ever disagree, the difference is
              visible instead of hidden behind one of them. */}
          <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            <SectionLabel>Signing kernel says</SectionLabel>
            {preview.preview.summaries.map((line, index) => (
              <p key={index} className="mt-1.5 text-[11px] leading-snug text-fg-muted">
                {line}
              </p>
            ))}
          </section>

          <section className="flex flex-col gap-1.5 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            <KeyValueRow
              label="Network fee"
              value={
                feeCoin
                  ? `${formatUnits(feeCoin.amount, entry?.feeDecimals ?? 6)} ${entry?.feeDenom ?? feeCoin.denom}`
                  : "none"
              }
            />
            <KeyValueRow label="Gas" value={preview.fee.gas_limit} />
            <KeyValueRow
              label="Sign bytes"
              value={`${preview.preview.signBytesHash.slice(0, 12)}…`}
            />
          </section>

          {preview.feeNote ? (
            <Callout tone="warning" title="Fee is an estimate">
              {preview.feeNote}
            </Callout>
          ) : null}

          {error ? (
            <Callout tone="danger" title="Could not sign">
              {error}
            </Callout>
          ) : null}
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
    return (
      <ScreenScaffold
        title={sent.success ? "Submitted" : "Rejected"}
        footer={
          <Button className="w-full" onClick={onBack}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          {/* Never a success screen for something that has not succeeded. A
              `sync` broadcast tells us the node accepted the transaction into
              its mempool and nothing more, so the NFT has not moved yet and
              this does not say it has. */}
          {sent.success ? (
            <Callout tone="info" title="Sent to the network, not yet confirmed">
              {wasCross
                ? `If it is included in a block, the NFT is escrowed by the bridge contract on ${entry?.chainName ?? chainId} and a voucher is minted on ${pending?.destChainName ?? "the destination"} once a relayer delivers the packet.`
                : `If it is included in a block, token ${tokenId} belongs to ${truncateAddress(recipient.trim(), 8, 6)} and this wallet no longer controls it.`}
            </Callout>
          ) : (
            <Callout tone="danger" title="The node rejected this transaction">
              Nothing moved. The chain answered with code {sent.code}
              {sent.rawLog ? `: ${sent.rawLog}` : "."}
            </Callout>
          )}
          <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            <SectionLabel>Transaction</SectionLabel>
            {/* No explorer is configured for this chain, so the hash is plain
                selectable text. A guessed explorer domain either 404s or shows
                somebody else's chain. */}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className={cn("mt-1.5 block break-all font-mono text-[10px] text-fg underline", focusRing)}
              >
                {txHash}
              </a>
            ) : (
              <p className="m-0 mt-1.5 break-all font-mono text-[10px] leading-relaxed text-fg">
                {txHash}
              </p>
            )}
          </section>
          <p className="m-0 text-[10px] leading-snug text-fg-muted">
            Zunia does not wait for a block. Re-open this token to see who owns
            it now, or find the hash above in Activity.
          </p>
        </div>
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
              <div className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={destPickerOpen}
                  disabled={destChains.length === 0}
                  onClick={() => setDestPickerOpen((v) => !v)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-2 text-left",
                    "hover:bg-[var(--z-state-hover)] disabled:cursor-not-allowed disabled:opacity-50",
                    focusRing,
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
                    {destChain?.entry.chainName ??
                      (destChains.length === 0
                        ? "No other CosmWasm network is enabled"
                        : "Pick a destination network")}
                  </span>
                  <IconChevronDown width={14} height={14} className="shrink-0 text-fg-dim" />
                </button>
                <OverlayMenu open={destPickerOpen} onClose={() => setDestPickerOpen(false)}>
                  {destChains.map((option) => (
                    <OverlayMenuItem
                      key={option.chainId}
                      selected={option.chainId === destChainId}
                      onSelect={() => {
                        setDestChainId(option.chainId);
                        setChannelId("");
                        setChannelNote(null);
                        setDestPickerOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                        {option.entry.chainName}
                      </span>
                    </OverlayMenuItem>
                  ))}
                </OverlayMenu>
              </div>

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
            {contacts.length > 0 && !recipient ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {contacts.slice(0, 4).map((contact) => (
                  <li key={contact.id}>
                    <button
                      type="button"
                      onClick={() => setRecipient(contact.address)}
                      className={cn(
                        "rounded-full border border-[var(--z-line)] px-2.5 py-1 text-[10.5px] text-fg-muted hover:text-fg",
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
          <Callout tone="neutral" title="NFTs are not available on this chain">
            {support.reason}
          </Callout>
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
          onRequestMedia={media.togglable ? () => media.setEnabled(true) : undefined}
          tokenUri={token?.tokenUri ?? null}
          loading={loading}
          error={current?.error ?? null}
          actions={
            <div className="flex w-full flex-col gap-1.5">
              {view?.metadataError ? (
                <p className="m-0 text-[10px] leading-snug text-[var(--z-warning)]">
                  Off-chain metadata could not be read ({view.metadataError}), so
                  only what the contract stores on chain is shown.
                </p>
              ) : null}
              {view?.metadataSource === "chain" ? (
                <p className="m-0 text-[10px] leading-snug text-fg-muted">
                  Everything above comes from the contract&rsquo;s own state. No
                  off-chain host was contacted.
                </p>
              ) : null}
              {view?.metadataSource === "none" && !media.enabled && token?.tokenUri ? (
                <p className="m-0 text-[10px] leading-snug text-fg-muted">
                  This token stores no metadata on chain. Its name and artwork
                  live at the address above and were not fetched.
                </p>
              ) : null}
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
