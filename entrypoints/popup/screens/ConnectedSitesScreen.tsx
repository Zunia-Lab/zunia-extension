import { useMemo, useState } from "react";
import {
  Avatar,
  Button,
  EmptyState,
  ScreenScaffold,
  SearchField,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { OriginGrant } from "../../../lib/permissions";
import { findCatalogEntry, catalogIconFor } from "../../../lib/chain-catalog";
import { relativeTime, timeUntil } from "../../../lib/format";
import { assessOrigin } from "../../../lib/origin-risk";
import { searchItems } from "../../../lib/picker";
import { sendToBackground } from "../../../lib/popup-client";
import { useToast } from "../state/Toasts";
import { IconClose, IconGlobe } from "./icons";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

function chainName(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/**
 * The site's icon, fetched from the site itself and only over HTTPS. It
 * already knows the user visits it; no third-party icon service is asked.
 */
function SiteIcon({ origin }: { origin: string }) {
  const [failed, setFailed] = useState(false);
  const src = origin.startsWith("https://") && !failed ? `${origin}/favicon.ico` : undefined;
  return src ? (
    <Avatar src={src} fallback={hostOf(origin)} size={30} onError={() => setFailed(true)} />
  ) : (
    <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted">
      <IconGlobe width={16} height={16} />
    </span>
  );
}

function usageLine(grant: OriginGrant): string {
  const used = grant.lastUsedAt ? `Used ${relativeTime(grant.lastUsedAt)}` : "Not used yet";
  const expiry = grant.expiresAt ? `expires ${timeUntil(grant.expiresAt)}` : "no expiry";
  return `${used} · ${expiry}`;
}

function SiteCard({
  grant,
  busy,
  onRevokeSite,
  onRevokeChain,
}: {
  grant: OriginGrant;
  busy: string | null;
  onRevokeSite: (grant: OriginGrant) => void;
  onRevokeChain: (grant: OriginGrant, chainId: string) => void;
}) {
  const host = hostOf(grant.origin);
  const risk = assessOrigin(grant.origin);
  const suspicious = risk.level === "suspicious";

  return (
    <li
      className={cn(
        "flex flex-col gap-2.5 rounded-[14px] border bg-[var(--z-glass)] px-3 py-3",
        suspicious ? "border-[var(--z-danger-line)]" : "border-[var(--z-line)]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <SiteIcon origin={grant.origin} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-fg">{host}</span>
          <span
            className={cn(
              "mt-0.5 block truncate font-mono text-[9.5px]",
              suspicious ? "text-[var(--z-danger-fg)]" : "text-fg-dim",
            )}
            title={suspicious ? risk.warnings.join(" ") : grant.origin}
          >
            {grant.origin}
          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-fg-muted">
            {usageLine(grant)}
          </span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          loading={busy === grant.origin}
          disabled={busy !== null}
          onClick={() => onRevokeSite(grant)}
        >
          Disconnect
        </Button>
      </div>

      <ul className="flex flex-col border-t border-[var(--z-line)] pt-1.5">
        {grant.chainIds.map((chainId) => {
          const entry = findCatalogEntry(chainId);
          const address = grant.accounts[chainId];
          const key = `${grant.origin}|${chainId}`;
          return (
            <li key={chainId} className="flex items-center gap-2 py-1">
              <Avatar
                src={entry ? catalogIconFor(entry) : undefined}
                fallback={chainName(chainId)}
                size={18}
              />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                {chainName(chainId)}
              </span>
              <span
                className="shrink-0 font-mono text-[9.5px] text-fg-dim"
                title={address ?? "The site has not read an address on this network yet"}
              >
                {address ? truncateAddress(address, 8, 4) : "not read yet"}
              </span>
              {grant.chainIds.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove ${chainName(chainId)} from ${host}`}
                  disabled={busy !== null}
                  onClick={() => onRevokeChain(grant, chainId)}
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full text-fg-dim",
                    "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                    "disabled:opacity-50",
                    busy === key && "animate-pulse",
                    focusRing,
                  )}
                >
                  <IconClose width={12} height={12} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function ConnectedSitesScreen({
  grants,
  onBack,
  onRefresh,
}: {
  grants: OriginGrant[];
  onBack: () => void;
  onRefresh: () => void;
}) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  const shown = useMemo(() => {
    const sorted = [...grants].sort(
      (a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
    );
    if (!query.trim()) return sorted;
    const byOrigin = new Map(sorted.map((grant) => [grant.origin, grant]));
    return searchItems(
      sorted.map((grant) => ({
        id: grant.origin,
        label: hostOf(grant.origin),
        sublabel: grant.origin,
        keywords: [
          ...grant.chainIds,
          ...grant.chainIds.map(chainName),
          ...Object.values(grant.accounts),
        ],
      })),
      query,
    ).flatMap((item) => byOrigin.get(item.id) ?? []);
  }, [grants, query]);

  async function run(key: string, task: () => Promise<unknown>, done: string, meta: string) {
    setBusy(key);
    try {
      await task();
      toast(done, { meta });
    } catch (caught) {
      toast("Could not disconnect", {
        tone: "danger",
        meta: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(null);
      onRefresh();
    }
  }

  const revokeSite = (grant: OriginGrant) =>
    void run(
      grant.origin,
      () => sendToBackground("REVOKE_PERMISSION", { origin: grant.origin }),
      "Site disconnected",
      hostOf(grant.origin),
    );

  const revokeChain = (grant: OriginGrant, chainId: string) =>
    void run(
      `${grant.origin}|${chainId}`,
      () => sendToBackground("REVOKE_PERMISSION", { origin: grant.origin, chainId }),
      `${chainName(chainId)} removed`,
      hostOf(grant.origin),
    );

  const revokeAll = () =>
    void run(
      "all",
      () => sendToBackground("REVOKE_ALL_PERMISSIONS"),
      "Every site disconnected",
      `${grants.length} site${grants.length === 1 ? "" : "s"}`,
    ).then(() => setConfirmAll(false));

  return (
    <ScreenScaffold
      title="Connected dApps"
      onBack={onBack}
      footer={
        grants.length === 0 ? undefined : confirmAll ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-[11.5px] text-fg">
              Disconnect all {grants.length} site{grants.length === 1 ? "" : "s"}? Each one
              has to ask again before it can see an address.
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={busy !== null}
                onClick={() => setConfirmAll(false)}
              >
                Keep
              </Button>
              <Button
                variant="danger"
                className="flex-1"
                loading={busy === "all"}
                disabled={busy !== null && busy !== "all"}
                onClick={revokeAll}
              >
                Disconnect all
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            disabled={busy !== null}
            onClick={() => setConfirmAll(true)}
          >
            Disconnect all sites
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-[12px] leading-[1.5] text-fg-muted">
          Each site sees only the networks it asked for and the address shown
          next to each. Disconnect a network or the whole site anytime; the site
          is told at once and has to ask again.
        </p>

        {grants.length > 1 ? (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Search sites, networks, or addresses"
          />
        ) : null}

        {grants.length === 0 ? (
          <EmptyState
            icon={<IconGlobe width={16} height={16} />}
            title="No connected dApps"
            description="Sites you approve will be listed here with the chains they can see."
          />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-fg-muted">
            No site matches "{query.trim()}".
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shown.map((grant) => (
              <SiteCard
                key={grant.origin}
                grant={grant}
                busy={busy}
                onRevokeSite={revokeSite}
                onRevokeChain={revokeChain}
              />
            ))}
          </ul>
        )}
      </div>
    </ScreenScaffold>
  );
}
