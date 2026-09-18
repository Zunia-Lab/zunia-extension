/**
 * The NFTs an account holds on one chain.
 *
 * Three facts shape this screen and are all visible on it:
 *
 * 1. Only 118 of the 332 chains in the registry declare `cosmwasm`, so most
 *    chains cannot hold a CW721 token at all. Those get a sentence saying so,
 *    never an empty grid.
 * 2. CosmWasm has no chain-level "tokens by owner" index. A wallet can only ask
 *    contracts it already knows about, so the screen says which contracts it
 *    asked and never presents an unqueried chain as an empty one.
 * 3. Artwork lives on hosts the token's minter chose. Loading it tells those
 *    hosts the user's IP and which tokens they hold, so it is off until the
 *    user turns it on, next to the sentence explaining what that costs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Checkbox,
  EmptyState,
  NFT_MEDIA_PRIVACY_NOTE,
  NftGrid,
  ScreenScaffold,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
  type NftCardItem,
} from "@zunialab/ui";

import { NFT_DETAIL_CONCURRENCY, NFT_DETAIL_PREFETCH } from "../../../config/nft";
import { describeInterchainError } from "../../../lib/interchain";
import {
  loadToken,
  mediaTargetFor,
  nftChainSupport,
  NFT_LIST_LIMITATION,
  type NftCollectionView,
  type NftTokenView,
} from "../../../lib/nft";
import type { PopupRoute } from "../routes";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { OverlayMenu, OverlayMenuItem } from "../components/OverlayMenu";
import {
  ContractManager,
  ScanDisclosure,
  SourcePill,
  useNftChains,
  useNftDiscovery,
  useNftMediaGate,
} from "./nft-ui";
import { IconChevronDown, IconNft, IconRefresh } from "./icons";

/**
 * Stable identity for "no collections yet".
 *
 * A fresh `[]` on every render would change the detail plan's identity and
 * re-run its effect on every render while discovery is still in flight.
 */
const NO_COLLECTIONS: readonly NftCollectionView[] = [];

/** Key for the token detail cache. A token id is unique only within a contract. */
function tokenKey(contract: string, tokenId: string): string {
  return `${contract}:${tokenId}`;
}

/**
 * Read on-chain detail for the tokens on screen, a few at a time.
 *
 * Discovery returns token ids; a name, a trait list and an image reference each
 * cost one more `all_nft_info` query per token. The grid therefore renders from
 * the ids immediately and this fills in behind it, capped and throttled because
 * these are public LCD nodes. Tokens past the cap keep their id and the screen
 * says the rest were not read - which is true, and better than a slow screen or
 * a rate-limited one.
 */
function useTokenDetails(input: {
  chainId: string | null;
  collections: readonly NftCollectionView[];
  withOffChainMetadata: boolean;
  reloadToken: number;
}): {
  details: ReadonlyMap<string, NftTokenView>;
  loading: boolean;
  /** Tokens beyond the prefetch cap, which were deliberately not read. */
  notRead: number;
  errors: readonly string[];
} {
  const { chainId, collections, withOffChainMetadata, reloadToken } = input;

  // A stable identity for "the exact tokens to read", so the effect does not
  // re-run on every render of a new array with the same contents.
  const plan = useMemo(() => {
    const rows: Array<{ contract: string; tokenId: string; name: string | null }> = [];
    for (const collection of collections) {
      for (const tokenId of collection.tokenIds) {
        rows.push({
          contract: collection.contractAddress,
          tokenId,
          name: collection.info?.name ?? null,
        });
      }
    }
    return rows;
  }, [collections]);
  const planKey = `${chainId ?? ""}|${withOffChainMetadata}|${reloadToken}|${plan
    .map((row) => tokenKey(row.contract, row.tokenId))
    .join(",")}`;

  const [settled, setSettled] = useState<{
    planKey: string;
    details: Map<string, NftTokenView>;
    errors: string[];
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (!chainId || plan.length === 0) return;
    const controller = new AbortController();
    const targets = plan.slice(0, NFT_DETAIL_PREFETCH);
    const details = new Map<string, NftTokenView>();
    const errors: string[] = [];
    let next = 0;

    async function worker() {
      for (;;) {
        const index = next++;
        const target = targets[index];
        if (!target || controller.signal.aborted) return;
        try {
          const view = await loadToken(chainId!, target.contract, target.tokenId, {
            withOffChainMetadata,
            collectionName: target.name,
            signal: controller.signal,
          });
          details.set(tokenKey(target.contract, target.tokenId), view);
        } catch (error) {
          if (controller.signal.aborted) return;
          errors.push(
            `${target.tokenId}: ${describeInterchainError(error)}`,
          );
        }
        if (!controller.signal.aborted) {
          // Publish as they land so the grid fills in rather than blinking once
          // at the end. A new Map each time keeps React's identity check honest.
          setSettled({
            planKey,
            details: new Map(details),
            errors: [...errors],
            done: false,
          });
        }
      }
    }

    void Promise.all(
      Array.from({ length: Math.min(NFT_DETAIL_CONCURRENCY, targets.length) }, worker),
    ).then(() => {
      if (!controller.signal.aborted) {
        setSettled({ planKey, details: new Map(details), errors: [...errors], done: true });
      }
    });

    return () => controller.abort();
  }, [planKey, chainId, plan, withOffChainMetadata]);

  const current = settled?.planKey === planKey ? settled : null;
  return {
    details: current?.details ?? new Map(),
    loading: plan.length > 0 && !current?.done,
    notRead: Math.max(0, plan.length - NFT_DETAIL_PREFETCH),
    errors: current?.errors ?? [],
  };
}

export function NftScreen({
  chains,
  initialChainId,
  onBack,
  onOpenToken,
  onNavigate,
}: {
  chains: readonly ChainAccountView[];
  initialChainId?: string;
  onBack: () => void;
  onOpenToken: (input: {
    chainId: string;
    collectionAddress: string;
    tokenId: string;
  }) => void;
  onNavigate: (route: PopupRoute) => void;
}) {
  const { settings } = usePrefs();
  const liveReads = settings.liveBalances;
  const media = useNftMediaGate();
  const { supported, unsupported } = useNftChains(chains);

  // Only the user's explicit pick is state. The chain actually shown is derived
  // from it, so a chain disabled in Networks while this screen is open falls
  // back on the next render instead of needing an effect to correct itself.
  const [picked, setPicked] = useState<string | null>(
    initialChainId && nftChainSupport(initialChainId).supported ? initialChainId : null,
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [contractsToken, setContractsToken] = useState(0);

  const chain =
    supported.find((row) => row.chainId === picked) ?? supported[0] ?? null;
  const chainId = chain?.chainId ?? null;
  const owner = chain?.address && chain.address.length > 0 ? chain.address : null;

  const discovery = useNftDiscovery({
    chainId,
    owner,
    enabled: liveReads && Boolean(chain && owner),
  });

  const collections = discovery.result?.collections ?? NO_COLLECTIONS;
  const detail = useTokenDetails({
    chainId,
    collections,
    withOffChainMetadata: media.enabled,
    reloadToken: contractsToken,
  });

  const onContractsChanged = useCallback(() => {
    setContractsToken((n) => n + 1);
    discovery.reload();
  }, [discovery]);

  /* ------------------------------------------------------------------ *
   * Blocking states, most specific first
   * ------------------------------------------------------------------ */

  const blocked = useMemo((): { title: string; body: string } | null => {
    if (chains.length === 0) {
      return {
        title: "No networks enabled",
        body: "Turn on a network that runs CosmWasm before Zunia can look for NFTs.",
      };
    }
    if (supported.length === 0) {
      return {
        title: "None of your networks can hold NFTs",
        body: `CW721 needs CosmWasm, and none of your ${chains.length} enabled network${
          chains.length === 1 ? "" : "s"
        } declares it in the chain registry. Enable a CosmWasm chain from Networks and this screen will read it.`,
      };
    }
    if (!liveReads) {
      return {
        title: "Live reads are off",
        body: "Finding NFTs means querying each collection's contract on the chain. Turn on live balances in Settings, Preferences and Zunia will look.",
      };
    }
    if (!owner) {
      return {
        title: "No address on this network",
        body: `Zunia could not derive your ${chain?.entry.chainName ?? "chain"} address, so it has no owner to ask about. Unlock the wallet and try again.`,
      };
    }
    return null;
  }, [chains.length, supported.length, liveReads, owner, chain]);

  /* ------------------------------------------------------------------ *
   * Cards
   * ------------------------------------------------------------------ */

  // Artwork is only handed to a card once its detail read has settled. Until
  // then `loadMedia` stays false: `NftMedia` reads "media on, no image" as "this
  // token has no artwork", which is not what "we have not looked yet" means.
  const artworkReady = media.enabled && !detail.loading;

  function itemsFor(collection: NftCollectionView): NftCardItem[] {
    return collection.tokenIds.map((tokenId) => {
      const view = detail.details.get(tokenKey(collection.contractAddress, tokenId));
      const image = media.enabled ? mediaTargetFor(view?.token.imageUri).url : null;
      return {
        tokenId,
        name: view?.token.name ?? null,
        collectionAddress: collection.contractAddress,
        collectionName: collection.info?.name ?? null,
        imageUrl: image,
      };
    });
  }

  const total = collections.reduce((sum, row) => sum + row.tokenIds.length, 0);
  // The chain the rendered collections came from, which is the discovery run's
  // chain and not the picker's: those differ for one render after a switch, and
  // opening a token against the wrong chain would query the wrong contract.
  const activeChainId = discovery.result?.chainId ?? chainId ?? "";

  return (
    <ScreenScaffold
      title="NFTs"
      onBack={onBack}
      right={
        <button
          type="button"
          aria-label="Reload collections"
          disabled={!liveReads || discovery.loading}
          onClick={() => discovery.reload()}
          className={cn(
            "flex size-[30px] items-center justify-center rounded-[10px] border border-[var(--z-line)] text-fg-muted",
            "hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
            focusRing,
          )}
        >
          {discovery.loading ? <Spinner /> : <IconRefresh width={15} height={15} />}
        </button>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {/* Chain picker. Only CosmWasm chains are listed; the rest are named
            underneath with the reason, so a missing chain is never a mystery. */}
        {supported.length > 0 ? (
          <section className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
              className={cn(
                "flex w-full items-center gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-2 text-left",
                "hover:bg-[var(--z-state-hover)]",
                focusRing,
              )}
            >
              <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--z-line)] text-fg-muted">
                <IconNft width={15} height={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-fg">
                  {chain?.entry.chainName ?? "Pick a network"}
                </span>
                <span className="block truncate font-mono text-[9px] text-fg-dim">
                  {owner ? truncateAddress(owner, 8, 6) : "no address"}
                </span>
              </span>
              <IconChevronDown width={14} height={14} className="shrink-0 text-fg-dim" />
            </button>
            <OverlayMenu open={pickerOpen} onClose={() => setPickerOpen(false)}>
              {supported.map((option) => (
                <OverlayMenuItem
                  key={option.chainId}
                  selected={option.chainId === chainId}
                  onSelect={() => {
                    setPicked(option.chainId);
                    setPickerOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-fg">
                      {option.entry.chainName}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-fg-dim">
                      {option.chainId}
                    </span>
                  </span>
                </OverlayMenuItem>
              ))}
            </OverlayMenu>
          </section>
        ) : null}

        {blocked ? (
          <>
            <Callout tone="neutral" title={blocked.title}>
              {blocked.body}
            </Callout>
            {supported.length === 0 ? (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => onNavigate("networks")}
              >
                Manage networks
              </Button>
            ) : null}
            {!liveReads ? (
              <Button
                size="sm"
                variant="secondary"
                className="self-start"
                onClick={() => onNavigate("preferences")}
              >
                Open Preferences
              </Button>
            ) : null}
          </>
        ) : null}

        {/* The artwork switch, with the sentence that explains what it costs.
            Rendered here rather than inside each grid so one decision covers
            the whole screen. */}
        {!blocked ? (
          <section className="flex flex-col gap-1.5 rounded-[13px] border border-[var(--z-line)] px-3 py-2.5">
            <Checkbox
              checked={media.enabled}
              disabled={!media.togglable}
              onCheckedChange={(next) => media.setEnabled(next === true)}
              label={
                <span className="text-[11.5px] text-fg">
                  Load artwork and off-chain details
                </span>
              }
            />
            <p className="m-0 text-[10px] leading-snug text-fg-muted">
              {media.blockedReason ?? NFT_MEDIA_PRIVACY_NOTE}
            </p>
          </section>
        ) : null}

        {discovery.error ? (
          <Callout tone="danger" title="Could not read this chain">
            {discovery.error}
          </Callout>
        ) : null}

        {discovery.result ? (
          <ScanDisclosure
            result={discovery.result}
            chainName={chain?.entry.chainName ?? discovery.result.chainId}
          />
        ) : null}

        {/* One grid per collection: the collection is the unit a user thinks
            in, and a flat grid of tokens from three contracts is unreadable at
            360px. */}
        {collections.map((collection) => (
          <section key={collection.contractAddress} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">
                  {collection.info?.name ??
                    truncateAddress(collection.contractAddress, 8, 6)}
                </span>
                <span className="block truncate font-mono text-[9px] text-fg-dim">
                  {collection.tokenIds.length} held
                  {collection.info?.symbol ? ` · ${collection.info.symbol}` : ""}
                  {collection.truncated ? " · list cut short" : ""}
                </span>
              </span>
              <SourcePill source={collection.source} />
            </div>
            {collection.infoError ? (
              <p className="m-0 text-[10px] leading-snug text-[var(--z-warning)]">
                Collection details could not be read ({collection.infoError}), so
                only the contract address is shown.
              </p>
            ) : null}
            {/* No `onToggleMedia` / `onRequestMedia` here on purpose: the
                artwork decision is one decision for the whole screen and it is
                made above, next to the sentence that explains what it
                discloses. A per-card "Load artwork" bar would repeat that
                choice a dozen times without repeating the explanation.
                `minItemWidth` 140 keeps two columns inside the popup's 328px
                content box (2x140 + 8px gap). */}
            <NftGrid
              items={itemsFor(collection)}
              loadMedia={artworkReady}
              loading={detail.loading}
              minItemWidth={140}
              onSelect={(item) =>
                onOpenToken({
                  chainId: activeChainId,
                  collectionAddress: collection.contractAddress,
                  tokenId: item.tokenId,
                })
              }
            />
          </section>
        ))}

        {/* Zero collections is only ever rendered when something really was
            queried. `ScanDisclosure` owns the other case and says nothing was
            asked, so this sentence is never a claim the wallet cannot make. */}
        {!blocked &&
        discovery.result &&
        collections.length === 0 &&
        !discovery.result.scan.queriedNothing ? (
          <EmptyState
            icon={<IconNft width={16} height={16} />}
            title="Nothing found in the collections Zunia asked"
            description={NFT_LIST_LIMITATION}
          />
        ) : null}

        {discovery.loading && !discovery.result ? (
          <div className="flex items-center justify-center gap-2 py-6 text-fg-dim">
            <Spinner />
            <span className="text-[11px]">Asking each collection…</span>
          </div>
        ) : null}

        {detail.notRead > 0 ? (
          <p className="m-0 text-[10px] leading-snug text-fg-muted">
            Details were read for the first {NFT_DETAIL_PREFETCH} of {total} tokens.
            The rest show their token id; open one to read it in full.
          </p>
        ) : null}

        {detail.errors.length > 0 ? (
          <Callout tone="warning" title="Some tokens could not be read">
            <ul className="flex flex-col gap-1">
              {detail.errors.slice(0, 4).map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {chain ? (
          <ContractManager chainId={chain.chainId} onChanged={onContractsChanged} />
        ) : null}

        {unsupported.length > 0 ? (
          <section className="flex flex-col gap-1.5">
            <p className="m-0 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Networks without NFTs
            </p>
            <ul className="flex flex-col gap-1">
              {unsupported.map(({ chain: row, support }) => (
                <li
                  key={row.chainId}
                  className="rounded-[11px] border border-[var(--z-line)] px-2.5 py-2"
                >
                  <span className="block truncate text-[11.5px] text-fg">
                    {row.entry.chainName}
                  </span>
                  <span className="mt-0.5 block text-[10px] leading-snug text-fg-muted">
                    {support.reason}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}
