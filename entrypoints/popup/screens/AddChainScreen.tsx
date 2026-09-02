import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Input,
  NetworkOptionCard,
  ScreenScaffold,
  SearchField,
  Segmented,
  cn,
  focusRing,
} from "@zunialab/ui";
import {
  CHAIN_CATALOG,
  catalogIconFor,
  findCatalogEntry,
  matchesChainQuery,
  sortCatalog,
  type CatalogEntry,
} from "../../../lib/chain-catalog";
import type { CustomChainDraft } from "../../../lib/custom-chains";
import { sendToBackground } from "../../../lib/popup-client";
import { IconTrash } from "./icons";

type Mode = "registry" | "manual";

interface Draft {
  chainName: string;
  chainId: string;
  rpc: string;
  rest: string;
  bech32Prefix: string;
  coinType: string;
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: string;
  gasPrice: string;
}

const EMPTY: Draft = {
  chainName: "",
  chainId: "",
  rpc: "",
  rest: "",
  bech32Prefix: "",
  coinType: "118",
  coinDenom: "",
  coinMinimalDenom: "",
  coinDecimals: "6",
  gasPrice: "0.025",
};

const SORTED_CATALOG = sortCatalog(CHAIN_CATALOG);

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Two ways to add a network: pick one the bundled registry already knows, or
 * type the endpoints yourself. Manual chains are validated locally and only
 * contacted when the user presses Test.
 */
export function AddChainScreen({
  onBack,
  onSaved,
}: {
  onBack: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<Mode>("registry");
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<string[]>([]);
  const [custom, setCustom] = useState<CatalogEntry[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tested, setTested] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sendToBackground<string[]>("GET_ENABLED_CHAINS").then(setEnabled);
    void sendToBackground<CatalogEntry[]>("LIST_CUSTOM_CHAINS").then(setCustom);
  }, []);

  const results = useMemo(
    () =>
      query.trim()
        ? SORTED_CATALOG.filter((c) => matchesChainQuery(c, query)).slice(0, 25)
        : SORTED_CATALOG.slice(0, 25),
    [query],
  );

  const duplicate = Boolean(findCatalogEntry(draft.chainId.trim()));
  const errors = {
    chainName: draft.chainName.trim().length === 0,
    chainId: draft.chainId.trim().length === 0 || duplicate,
    rpc: draft.rpc.length > 0 && !isHttps(draft.rpc),
    rest: draft.rest.length > 0 && !isHttps(draft.rest),
    bech32Prefix: !/^[a-z]{2,}$/.test(draft.bech32Prefix),
    coinType: !/^\d+$/.test(draft.coinType),
    coinMinimalDenom: draft.coinMinimalDenom.trim().length === 0,
  };
  const complete =
    !Object.values(errors).some(Boolean) &&
    isHttps(draft.rpc) &&
    isHttps(draft.rest);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setTested(null);
    setError(null);
  }

  async function toggleRegistryChain(chainId: string) {
    const next = enabled.includes(chainId)
      ? enabled.filter((id) => id !== chainId)
      : [...enabled, chainId];
    if (next.length === 0) {
      setError("Keep at least one network enabled");
      return;
    }
    setEnabled(next);
    setError(null);
    try {
      await sendToBackground("SET_ENABLED_CHAINS", { chainIds: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      const ids = await sendToBackground<string[]>("GET_ENABLED_CHAINS");
      setEnabled(ids);
    }
  }

  async function test() {
    setTesting(true);
    setTested(null);
    try {
      const res = await fetch(
        `${draft.rest.replace(/\/$/, "")}/cosmos/base/tendermint/v1beta1/node_info`,
        { credentials: "omit" },
      );
      setTested(res.ok ? `${res.status} OK` : `HTTP ${res.status}`);
    } catch {
      setTested("Unreachable from this browser");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: CustomChainDraft = {
        chainName: draft.chainName.trim(),
        chainId: draft.chainId.trim(),
        rpc: draft.rpc.trim(),
        rest: draft.rest.trim(),
        bech32Prefix: draft.bech32Prefix.trim(),
        coinType: Number(draft.coinType),
        coinDenom:
          draft.coinDenom.trim().toUpperCase() ||
          draft.coinMinimalDenom.trim().replace(/^u/, "").toUpperCase(),
        coinMinimalDenom: draft.coinMinimalDenom.trim(),
        coinDecimals: Number(draft.coinDecimals) || 6,
        gasPrice: Number(draft.gasPrice) || 0.025,
      };
      const rows = await sendToBackground<CatalogEntry[]>("SAVE_CUSTOM_CHAIN", {
        draft: payload,
      });
      setCustom(rows);
      await sendToBackground("SET_ENABLED_CHAINS", {
        chainIds: [...new Set([...enabled, payload.chainId])],
      });
      setDraft(EMPTY);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(chainId: string) {
    const rows = await sendToBackground<CatalogEntry[]>(
      "REMOVE_CUSTOM_CHAIN",
      { chainId },
    );
    setCustom(rows);
    setEnabled((prev) => prev.filter((id) => id !== chainId));
  }

  return (
    <ScreenScaffold
      title="Add network"
      onBack={onBack}
      footer={
        mode === "manual" ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              loading={testing}
              disabled={!isHttps(draft.rest)}
              onClick={() => void test()}
            >
              Test
            </Button>
            <Button
              className="flex-1"
              loading={saving}
              disabled={!complete}
              onClick={() => void save()}
            >
              Save chain
            </Button>
          </div>
        ) : (
          <Button className="w-full" onClick={onBack}>
            Done
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <Segmented
          className="w-full min-w-0"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: "registry", label: "Registry" },
            { value: "manual", label: "Manual" },
          ]}
        />

        {error ? <Callout tone="danger">{error}</Callout> : null}

        {mode === "registry" ? (
          <>
            <SearchField
              value={query}
              onValueChange={setQuery}
              placeholder="Search name, chain id, or denom"
              aria-label="Search the registry"
            />
            <ul className="flex min-w-0 flex-col gap-1.5">
              {results.map((chain) => (
                <li key={chain.chainId} className="min-w-0">
                  <NetworkOptionCard
                    name={chain.chainName}
                    chainId={chain.chainId}
                    symbol={chain.coinDenom}
                    iconUrl={catalogIconFor(chain)}
                    testnet={chain.network === "testnet"}
                    selected={enabled.includes(chain.chainId)}
                    control="switch"
                    onToggle={() => void toggleRegistryChain(chain.chainId)}
                  />
                </li>
              ))}
            </ul>
            {results.length === 0 ? (
              <p className="rounded-[14px] border border-dashed border-[var(--z-line)] px-3 py-6 text-center text-[11.5px] text-fg-dim">
                Nothing in the registry matches “{query.trim()}”. Switch to
                Manual to add it yourself.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <Input
              label="Chain name"
              placeholder="Safrochain Devnet"
              value={draft.chainName}
              onChange={(e) => set("chainName", e.target.value)}
            />
            <Input
              label="Chain ID"
              placeholder="safro-devnet-2"
              value={draft.chainId}
              spellCheck={false}
              state={duplicate ? "error" : "default"}
              hint={duplicate ? "That chain ID already exists" : undefined}
              onChange={(e) => set("chainId", e.target.value)}
            />
            <Input
              label="RPC"
              placeholder="https://rpc.example.com"
              value={draft.rpc}
              spellCheck={false}
              state={errors.rpc ? "error" : draft.rpc ? "valid" : "default"}
              hint={errors.rpc ? "Must be an https:// URL" : undefined}
              onChange={(e) => set("rpc", e.target.value.trim())}
            />
            <Input
              label="REST"
              placeholder="https://api.example.com"
              value={draft.rest}
              spellCheck={false}
              state={errors.rest ? "error" : draft.rest ? "valid" : "default"}
              hint={
                tested ?? (errors.rest ? "Must be an https:// URL" : undefined)
              }
              onChange={(e) => set("rest", e.target.value.trim())}
            />

            <div className="flex gap-2.5">
              <Input
                className="flex-1"
                label="Prefix"
                placeholder="safro"
                value={draft.bech32Prefix}
                spellCheck={false}
                onChange={(e) =>
                  set("bech32Prefix", e.target.value.toLowerCase())
                }
              />
              <Input
                className="flex-1"
                label="Coin type"
                placeholder="118"
                inputMode="numeric"
                value={draft.coinType}
                onChange={(e) => set("coinType", e.target.value)}
              />
            </div>

            <div className="flex gap-2.5">
              <Input
                className="flex-1"
                label="Base denom"
                placeholder="usaf"
                value={draft.coinMinimalDenom}
                spellCheck={false}
                onChange={(e) => set("coinMinimalDenom", e.target.value)}
              />
              <Input
                className="flex-1"
                label="Gas price"
                placeholder="0.025"
                inputMode="decimal"
                value={draft.gasPrice}
                onChange={(e) => set("gasPrice", e.target.value)}
              />
            </div>

            {custom.length > 0 ? (
              <section>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                  Your chains
                </p>
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {custom.map((chain) => (
                    <li
                      key={chain.chainId}
                      className="flex items-center gap-2 rounded-[11px] border border-[var(--z-line)] px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-fg">
                          {chain.chainName}
                        </span>
                        <span className="block truncate font-mono text-[9.5px] text-fg-dim">
                          {chain.chainId}
                        </span>
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${chain.chainName}`}
                        onClick={() => void remove(chain.chainId)}
                        className={cn(
                          "shrink-0 rounded-[8px] p-1.5 text-fg-dim",
                          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-[var(--z-danger)]",
                          focusRing,
                        )}
                      >
                        <IconTrash width={16} height={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <Callout tone="warning" title="Not in the registry">
              A custom chain is only as trustworthy as its endpoints. Add hosts
              you run or know, never ones a website handed you.
            </Callout>
          </>
        )}
      </div>
    </ScreenScaffold>
  );
}
