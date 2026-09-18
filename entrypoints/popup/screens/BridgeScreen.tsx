/**
 * Bridge: which rails out of this wallet actually work, and which do not.
 *
 * The IBC rail is real and is the cross-send flow on the Send screen — the
 * route planning, per-hop channel override and packet tracking all live there,
 * and a second copy of them here would be the fifth transfer implementation
 * this codebase is in the middle of deleting. What this screen adds is the
 * question cross-send cannot answer from inside its own form: *where can I
 * actually send from here*, according to the channels the wallet has verified.
 *
 * The EVM and Solana rails are not built. They are disabled and say why. The
 * previous version of this screen rendered a "Review bridge" button that could
 * never be pressed and three fee rows that were always an em dash.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  SectionLabel,
  Segmented,
  Spinner,
  cn,
  focusRing,
} from "@zunialab/ui";
import { findRoutePaths, type ChannelDirectory } from "@zunialab/interchain";

import type { ChainBalance } from "../../../lib/balances";
import { MAX_ROUTE_HOPS } from "../../../config/interchain";
import { formatUnits } from "../../../lib/format";
import { describeInterchainError } from "../../../lib/interchain";
import { channelDirectory, discoverChannels } from "../../../lib/route-plan";
import type { PopupRoute } from "../routes";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { DisabledReason } from "./interchain-ui";

type Rail = "ibc" | "evm" | "solana";

/**
 * Why each external rail is off.
 *
 * Written as what is missing, not as "coming soon": a user deciding how to move
 * funds today needs to know this wallet cannot do it, so they use something
 * that can.
 */
const RAIL_BLOCKED: Record<Exclude<Rail, "ibc">, string> = {
  evm: "Zunia has no EVM signer and no bridge contract integration, so it cannot move funds to or from Ethereum, Arbitrum or Base. Use a bridge you trust directly, then IBC from the Cosmos chain it delivers to.",
  solana:
    "Zunia has no Solana signer and no Wormhole integration, so it cannot move funds to or from Solana.",
};

interface Reach {
  readonly chainId: string;
  readonly chainName: string;
  readonly iconUrl?: string;
  readonly hops: number;
  readonly channels: readonly string[];
  /** True only when every channel on the path has been confirmed open. */
  readonly verified: boolean;
}

export function BridgeScreen({
  chains,
  balances,
  onBack,
  onNavigate,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  onBack: () => void;
  onNavigate?: (route: PopupRoute, chainId?: string) => void;
}) {
  const { hidden, settings } = usePrefs();
  const liveReads = settings.liveBalances;
  const [rail, setRail] = useState<Rail>("ibc");
  const [fromId, setFromId] = useState(chains[0]?.chainId ?? "");
  const [directory, setDirectory] = useState<ChannelDirectory | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const from = chains.find((c) => c.chainId === fromId) ?? chains[0];
  const fromBalance = from ? balances[from.chainId] : undefined;

  const reload = useCallback(() => {
    void channelDirectory().then(setDirectory);
  }, []);
  useEffect(reload, [reload]);

  const reachable = useMemo((): Reach[] => {
    if (!directory || !from) return [];
    const out: Reach[] = [];
    for (const candidate of chains) {
      if (candidate.chainId === from.chainId) continue;
      const paths = findRoutePaths(from.chainId, candidate.chainId, directory, {
        maxHops: MAX_ROUTE_HOPS,
        maxPaths: 1,
      });
      const best = paths[0];
      if (!best) continue;
      out.push({
        chainId: candidate.chainId,
        chainName: candidate.entry.chainName,
        ...(candidate.iconUrl ? { iconUrl: candidate.iconUrl } : {}),
        hops: best.links.length,
        channels: best.links.map((link) => link.channelId),
        // `state === "open"` is the only evidence. A shipped seed row and an
        // unchecked manual entry both read as not verified, on purpose.
        verified: best.links.every((link) => link.state === "open"),
      });
    }
    return out.sort((a, b) => a.hops - b.hops || a.chainName.localeCompare(b.chainName));
  }, [directory, from, chains]);

  const discoverFor = useCallback(
    (destChainId: string) => {
      if (!from) return;
      setDiscovering(destChainId);
      setError(null);
      void discoverChannels(from.chainId, destChainId)
        .then(reload)
        .catch((caught: unknown) => setError(describeInterchainError(caught)))
        .finally(() => setDiscovering(null));
    },
    [from, reload],
  );

  if (chains.length === 0) {
    return (
      <ScreenScaffold title="Bridge" onBack={onBack}>
        <Callout tone="warning" title="No networks enabled">
          Enable at least one network before bridging.
        </Callout>
      </ScreenScaffold>
    );
  }

  const railBlocked = rail === "ibc" ? null : RAIL_BLOCKED[rail];

  return (
    <ScreenScaffold
      title="Bridge"
      onBack={onBack}
      footer={
        <div>
          <Button
            className="w-full"
            disabled={rail !== "ibc" || !onNavigate}
            onClick={() => onNavigate?.("send", from?.chainId)}
          >
            {rail === "ibc" ? "Continue in Cross-send" : "Not available"}
          </Button>
          <DisabledReason
            reason={
              railBlocked ??
              (onNavigate
                ? null
                : "This screen was opened without navigation, so it cannot hand you to Cross-send. Open Send from the home screen.")
            }
          />
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <Segmented<Rail>
          value={rail}
          onChange={setRail}
          options={[
            { value: "ibc", label: "IBC" },
            { value: "evm", label: "EVM" },
            { value: "solana", label: "Solana" },
          ]}
        />

        {rail !== "ibc" ? (
          <Callout tone="warning" title={`${rail === "evm" ? "EVM" : "Solana"} is not built`}>
            {RAIL_BLOCKED[rail]}
          </Callout>
        ) : null}

        {rail === "ibc" ? (
          <>
            <section>
              <SectionLabel>From</SectionLabel>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {chains.map((option) => (
                  <button
                    key={option.chainId}
                    type="button"
                    aria-pressed={option.chainId === from?.chainId}
                    onClick={() => setFromId(option.chainId)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10.5px]",
                      option.chainId === from?.chainId
                        ? "border-[var(--z-line-strong)] bg-[var(--z-state-selected)] text-fg"
                        : "border-[var(--z-line)] text-fg-muted hover:text-fg",
                      focusRing,
                    )}
                  >
                    <Avatar
                      src={option.iconUrl}
                      fallback={option.entry.chainName}
                      size={16}
                    />
                    <span className="max-w-[92px] truncate">{option.entry.chainName}</span>
                  </button>
                ))}
              </div>
              {from ? (
                <p className="mt-1.5 font-mono text-[9.5px] text-fg-dim">
                  {hidden
                    ? "••••"
                    : fromBalance
                      ? `${formatUnits(fromBalance.available, fromBalance.decimals)} ${fromBalance.symbol} available`
                      : "balance unknown"}
                </p>
              ) : null}
            </section>

            <section>
              <SectionLabel>Reachable over IBC</SectionLabel>
              {!liveReads ? (
                <Callout tone="info" className="mt-1.5" title="On-chain reads are off">
                  Zunia can only show channels it has read from each chain. Turn on live
                  balances in Settings → Preferences.
                </Callout>
              ) : null}
              {reachable.length === 0 ? (
                <div className="mt-2">
                  <EmptyState
                    title="No route known yet"
                    description="Nothing in the channel cache connects this network to another enabled one. Run discovery on a destination below, or enter the channel by hand in Cross-send."
                  />
                </div>
              ) : (
                <ul className="mt-1.5 flex flex-col gap-1.5">
                  {reachable.map((row) => (
                    <li
                      key={row.chainId}
                      className="flex items-center gap-2 rounded-[11px] border border-[var(--z-line)] px-2.5 py-2"
                    >
                      <Avatar src={row.iconUrl} fallback={row.chainName} size={20} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[11.5px] text-fg">
                          {row.chainName}
                        </span>
                        <span className="block truncate font-mono text-[9px] text-fg-dim">
                          {row.hops === 1 ? "direct" : `${row.hops} hops`} ·{" "}
                          {row.channels.join(" → ")}
                        </span>
                      </span>
                      <Pill tone={row.verified ? "success" : "warning"}>
                        {row.verified ? "verified" : "unchecked"}
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <SectionLabel>Look for more channels</SectionLabel>
              <p className="mt-1 text-[10.5px] leading-snug text-fg-muted">
                Discovery walks every transfer channel on {from?.entry.chainName ?? "the source chain"} and
                resolves each connection. Slow or paginating endpoints regularly fail at it,
                which is why Cross-send always lets you type the channel instead.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chains
                  .filter((c) => c.chainId !== from?.chainId)
                  .map((option) => (
                    <button
                      key={option.chainId}
                      type="button"
                      disabled={!liveReads || discovering !== null}
                      onClick={() => discoverFor(option.chainId)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border border-[var(--z-line)] px-2 py-1 text-[10px] text-fg-muted",
                        "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                        "disabled:cursor-not-allowed disabled:opacity-40",
                        focusRing,
                      )}
                    >
                      {discovering === option.chainId ? (
                        <Spinner className="size-3" />
                      ) : null}
                      <span className="max-w-[92px] truncate">
                        {option.entry.chainName}
                      </span>
                    </button>
                  ))}
              </div>
              {error ? (
                <Callout tone="danger" className="mt-2" title="Discovery failed">
                  {error}
                </Callout>
              ) : null}
            </section>

            <Callout tone="neutral" title="IBC needs no custodian">
              An IBC transfer never leaves the interchain: the source chain escrows, the
              destination mints, and a failed packet is refunded. You sign once, on the
              source chain, and pay gas only there.
            </Callout>
          </>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}
