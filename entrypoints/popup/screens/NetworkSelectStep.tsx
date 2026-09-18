import { useEffect, useMemo, useState } from "react";
import {
  NetworkOptionCard,
  SearchField,
  Segmented,
  cn,
  focusRing,
} from "@zunialab/ui";
import {
  allCatalogEntries,
  catalogIconFor,
  matchesChainQuery,
  sortCatalog,
  type CatalogEntry,
} from "../../../lib/chain-catalog";
import { hydrateCustomChains } from "../../../lib/custom-chains";

type NetworkFilter = "mainnet" | "testnet" | "all";

const PAGE_SIZE = 40;

function QuickAction({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border border-[var(--z-line)] px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] hover:text-fg",
        focusRing,
      )}
    >
      {label}
    </button>
  );
}

/** Searchable chain multi-select shared by the create and import flows. */
export function NetworkSelectStep({
  selected,
  onToggle,
  onSelectMany,
  onClearMany,
  control = "check",
  defaultFilter = "mainnet",
}: {
  selected: Set<string>;
  onToggle: (chainId: string) => void;
  onSelectMany: (chainIds: string[]) => void;
  onClearMany: (chainIds: string[]) => void;
  control?: "check" | "switch";
  /** Manage Networks defaults to All so enabled testnets stay visible. */
  defaultFilter?: NetworkFilter;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<NetworkFilter>(defaultFilter);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [catalog, setCatalog] = useState<CatalogEntry[]>(() =>
    sortCatalog(allCatalogEntries()),
  );

  useEffect(() => {
    let cancelled = false;
    void hydrateCustomChains()
      .then(() => {
        if (cancelled) return;
        setCatalog(sortCatalog(allCatalogEntries()));
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog(sortCatalog(allCatalogEntries()));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const results = useMemo(() => {
    const filtered = catalog.filter(
      (c) =>
        (filter === "all" || c.network === filter) &&
        matchesChainQuery(c, query),
    );
    // Keep currently enabled chains at the top so they stay reachable under
    // any filter / search without hunting through pages.
    return [...filtered].sort((a, b) => {
      const aOn = selected.has(a.chainId) ? 0 : 1;
      const bOn = selected.has(b.chainId) ? 0 : 1;
      if (aOn !== bOn) return aOn - bOn;
      return 0;
    });
  }, [catalog, filter, query, selected]);

  const shown = results.slice(0, visible);
  const remaining = results.length - shown.length;
  const selectedInView = results.reduce(
    (n, c) => n + (selected.has(c.chainId) ? 1 : 0),
    0,
  );

  function update<T>(next: T, apply: (value: T) => void) {
    apply(next);
    setVisible(PAGE_SIZE);
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SearchField
        value={query}
        onValueChange={(v) => update(v, setQuery)}
        placeholder="Search name, chain id, or denom"
        aria-label="Search networks"
      />

      <Segmented
        className="w-full min-w-0"
        size="sm"
        value={filter}
        onChange={(v) => update(v as NetworkFilter, setFilter)}
        options={[
          { value: "mainnet", label: "Main" },
          { value: "testnet", label: "Test" },
          { value: "all", label: "All" },
        ]}
      />

      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
          {selected.size} on · {selectedInView}/{results.length} in view
        </span>
        <QuickAction
          label="Select all"
          onClick={() => onSelectMany(results.map((c) => c.chainId))}
        />
        <QuickAction
          label="Clear"
          onClick={() => onClearMany(results.map((c) => c.chainId))}
        />
      </div>

      <ul className="flex min-w-0 flex-col gap-1.5">
        {shown.map((chain: CatalogEntry) => (
          <li key={chain.chainId} className="min-w-0">
            <NetworkOptionCard
              name={chain.chainName}
              chainId={chain.chainId}
              symbol={chain.coinDenom}
              iconUrl={catalogIconFor(chain)}
              testnet={chain.network === "testnet"}
              selected={selected.has(chain.chainId)}
              control={control}
              onToggle={() => onToggle(chain.chainId)}
            />
          </li>
        ))}
      </ul>

      {results.length === 0 ? (
        <p className="rounded-[14px] border border-dashed border-[var(--z-line)] px-3 py-6 text-center text-[11.5px] text-fg-dim">
          No networks match “{query.trim() || filter}”
        </p>
      ) : null}

      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className={cn(
            "rounded-[12px] border border-dashed border-[var(--z-line)] py-2.5 text-[11.5px] text-fg-muted",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] hover:text-fg",
            focusRing,
          )}
        >
          Show {Math.min(remaining, PAGE_SIZE)} more · {remaining} left
        </button>
      ) : null}
    </div>
  );
}
