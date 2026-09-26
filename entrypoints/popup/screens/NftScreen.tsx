/**
 * The NFTs this wallet holds across every enabled CosmWasm network.
 *
 * All supported networks are queried at once, then the chips filter the grid.
 * Artwork is the Preferences switch, not a control on this screen.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  NftGrid,
  ScreenScaffold,
  SearchField,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
  type NftCardItem,
} from "@zunialab/ui";

import { NFT_DETAIL_CONCURRENCY, NFT_DETAIL_PREFETCH } from "../../../config/nft";
import { describeInterchainError } from "../../../lib/interchain";
import { searchItems } from "../../../lib/picker";
import {
  loadToken,
  mediaTargetFor,
  nftChainSupport,
  type NftCollectionView,
  type NftTokenView,
} from "../../../lib/nft";
import type { PopupRoute } from "../routes";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { NftGallerySkeleton } from "../components/ListSkeleton";
import {
  ContractManager,
  ScanDisclosure,
  SourcePill,
  useNftChains,
  useNftDiscoveryAll,
  useNftMediaGate,
} from "./nft-ui";
import { IconNft, IconRefresh } from "./icons";

/** Key for the token detail cache. A token id is unique only within a contract on a chain. */
function tokenKey(chainId: string, contract: string, tokenId: string): string {
  return `${chainId}:${contract}:${tokenId}`;
}

type NftCollectionRow = NftCollectionView & {
  chainId: string;
  chainName: string;
};

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
  collections: ReadonlyArray<NftCollectionView & { chainId: string }>;
  withOffChainMetadata: boolean;
  reloadToken: number;
}): {
  details: ReadonlyMap<string, NftTokenView>;
  loading: boolean;
  /** Tokens beyond the prefetch cap, which were deliberately not read. */
  notRead: number;
  errors: readonly string[];
} {
  const { collections, withOffChainMetadata, reloadToken } = input;

  // A stable identity for "the exact tokens to read", so the effect does not
  // re-run on every render of a new array with the same contents.
  const plan = useMemo(() => {
    const rows: Array<{
      chainId: string;
      contract: string;
      tokenId: string;
      name: string | null;
    }> = [];
    for (const collection of collections) {
      for (const tokenId of collection.tokenIds) {
        rows.push({
          chainId: collection.chainId,
          contract: collection.contractAddress,
          tokenId,
          name: collection.info?.name ?? null,
        });
      }
    }
    return rows;
  }, [collections]);
  const planKey = `${withOffChainMetadata}|${reloadToken}|${plan
    .map((row) => tokenKey(row.chainId, row.contract, row.tokenId))
    .join(",")}`;

  const [settled, setSettled] = useState<{
    planKey: string;
    details: Map<string, NftTokenView>;
    errors: string[];
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (plan.length === 0) return;
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
          const view = await loadToken(target.chainId, target.contract, target.tokenId, {
            withOffChainMetadata,
            collectionName: target.name,
            signal: controller.signal,
          });
          details.set(tokenKey(target.chainId, target.contract, target.tokenId), view);
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
  }, [planKey, plan, withOffChainMetadata]);

  const current = settled?.planKey === planKey ? settled : null;
  return {
    details: current?.details ?? new Map(),
    loading: plan.length > 0 && !current?.done,
    notRead: Math.max(0, plan.length - NFT_DETAIL_PREFETCH),
    errors: current?.errors ?? [],
  };
}

function FilterChip({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em]",
        "transition-colors duration-[var(--z-duration-base)]",
        selected
          ? "border-transparent bg-[var(--z-button)] text-[var(--z-button-fg)]"
          : "border-[var(--z-line-strong)] text-fg hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      {label}
    </button>
  );
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
  const { supported } = useNftChains(chains);

  const [filter, setFilter] = useState<string>(
    initialChainId && nftChainSupport(initialChainId).supported ? initialChainId : "all",
  );
  const [contractsToken, setContractsToken] = useState(0);
  const [query, setQuery] = useState("");

  const discovery = useNftDiscoveryAll({
    chains: supported,
    enabled: liveReads && supported.some((row) => Boolean(row.address)),
  });

  const names = useMemo(
    () => new Map(supported.map((row) => [row.chainId, row.entry.chainName])),
    [supported],
  );

  const collections = useMemo((): NftCollectionRow[] => {
    const rows: NftCollectionRow[] = [];
    for (const scan of discovery.rows) {
      if (filter !== "all" && scan.chainId !== filter) continue;
      for (const collection of scan.result?.collections ?? []) {
        rows.push({
          ...collection,
          chainId: scan.chainId,
          chainName: names.get(scan.chainId) ?? scan.chainId,
        });
      }
    }
    return rows;
  }, [discovery.rows, filter, names]);

  const visibleScans = useMemo(
    () =>
      filter === "all"
        ? discovery.rows
        : discovery.rows.filter((row) => row.chainId === filter),
    [discovery.rows, filter],
  );

  const detail = useTokenDetails({
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
        body: `None of your ${chains.length} enabled network${
          chains.length === 1 ? "" : "s"
        } exposes CosmWasm or the nft module. Enable a network that does and Zunia will list what you own.`,
      };
    }
    if (!liveReads) {
      return {
        title: "Live reads are off",
        body: "Finding NFTs means asking each chain who this address owns. Turn on live balances in Settings, Preferences and Zunia will look.",
      };
    }
    if (supported.every((row) => !row.address)) {
      return {
        title: "No address on these networks",
        body: "Zunia could not derive your address on any CosmWasm network, so it has no owner to ask about. Unlock the wallet and try again.",
      };
    }
    return null;
  }, [chains.length, supported, liveReads]);

  /* ------------------------------------------------------------------ *
   * Cards
   * ------------------------------------------------------------------ */

  // Artwork is only handed to a card once its detail read has settled. Until
  // then `loadMedia` stays false: `NftMedia` reads "media on, no image" as "this
  // token has no artwork", which is not what "we have not looked yet" means.
  const artworkReady = media.enabled && !detail.loading;

  function itemsFor(collection: NftCollectionRow): NftCardItem[] {
    return collection.tokenIds.map((tokenId) => {
      const view = detail.details.get(
        tokenKey(collection.chainId, collection.contractAddress, tokenId),
      );
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

  // A search that names the collection keeps all of it; otherwise only the
  // tokens whose name or id match are shown, and empty collections drop out.
  const q = query.trim();
  const visible = collections.flatMap((collection) => {
    const items = itemsFor(collection);
    if (!q) return [{ collection, items }];
    const collectionHit =
      searchItems(
        [
          {
            id: collection.contractAddress,
            label: collection.info?.name ?? "",
            keywords: [collection.info?.symbol ?? "", collection.contractAddress],
          },
        ],
        q,
      ).length > 0;
    if (collectionHit) return [{ collection, items }];
    const byId = new Map(items.map((item) => [item.tokenId, item]));
    const hits = searchItems(
      items.map((item) => ({
        id: item.tokenId,
        label: item.name ?? `#${item.tokenId}`,
        keywords: [item.tokenId],
      })),
      q,
    ).flatMap((hit) => byId.get(hit.id) ?? []);
    return hits.length > 0 ? [{ collection, items: hits }] : [];
  });

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
        {supported.length > 0 ? (
          <div
            className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5"
            role="tablist"
            aria-label="NFT network"
          >
            <FilterChip
              label="All"
              selected={filter === "all"}
              onSelect={() => {
                setFilter("all");
                setQuery("");
              }}
            />
            {supported.map((row) => (
              <FilterChip
                key={row.chainId}
                label={row.entry.chainName}
                selected={filter === row.chainId}
                onSelect={() => {
                  setFilter(row.chainId);
                  setQuery("");
                }}
              />
            ))}
          </div>
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

        {visibleScans
          .filter((row) => row.error)
          .map((row) => (
            <Callout
              key={`err-${row.chainId}`}
              tone="danger"
              title={`Could not read ${names.get(row.chainId) ?? row.chainId}`}
            >
              {row.error}
            </Callout>
          ))}

        {visibleScans
          .filter((row) => row.result)
          .map((row) => (
            <ScanDisclosure
              key={`scan-${row.chainId}`}
              result={row.result!}
              chainName={names.get(row.chainId) ?? row.chainId}
            />
          ))}

        {/* One grid per collection: the collection is the unit a user thinks
            in, and a flat grid of tokens from three contracts is unreadable at
            360px. */}
        {total > 4 ? (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Search collections and tokens"
          />
        ) : null}

        {q && visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-fg-muted">
            Nothing matches &ldquo;{q}&rdquo;.
          </p>
        ) : null}

        {visible.map(({ collection, items }) => (
          <section
            key={`${collection.chainId}:${collection.contractAddress}`}
            className="flex flex-col gap-2"
          >
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">
                  {collection.info?.name ??
                    truncateAddress(collection.contractAddress, 8, 6)}
                </span>
                <span className="block truncate font-mono text-[9px] text-fg-dim">
                  {collection.chainName}
                  {` · ${collection.tokenIds.length} held`}
                  {collection.info?.symbol ? ` · ${collection.info.symbol}` : ""}
                  {collection.truncated ? " · list cut short" : ""}
                </span>
              </span>
              <SourcePill source={collection.source} />
            </div>
            {/* No `onToggleMedia` / `onRequestMedia` here on purpose: the
                artwork decision is one decision for the whole screen and it is
                made above, next to the sentence that explains what it
                discloses. A per-card "Load artwork" bar would repeat that
                choice a dozen times without repeating the explanation.
                `minItemWidth` 140 keeps two columns inside the popup's 328px
                content box (2x140 + 8px gap). */}
            <NftGrid
              items={items}
              loadMedia={artworkReady}
              loading={detail.loading}
              minItemWidth={140}
              onSelect={(item) =>
                onOpenToken({
                  chainId: collection.chainId,
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
        !discovery.loading &&
        collections.length === 0 &&
        visibleScans.some((row) => row.result && !row.result.scan.queriedNothing) ? (
          <EmptyState
            icon={<IconNft width={16} height={16} />}
            title="No NFTs on these networks"
          />
        ) : null}

        {discovery.loading && collections.length === 0 ? (
          <NftGallerySkeleton collections={2} tiles={4} label="Asking each collection" />
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

        {supported.length > 0 ? (
          <ContractManager chains={supported} onChanged={onContractsChanged} />
        ) : null}
      </div>
    </ScreenScaffold>
  );
}
