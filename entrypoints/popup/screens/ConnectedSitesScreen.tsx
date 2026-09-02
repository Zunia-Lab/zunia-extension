import { Button, EmptyState, ScreenScaffold, cn } from "@zunialab/ui";
import type { OriginGrant } from "../../../lib/permissions";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import { IconGlobe } from "./icons";

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
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
  return (
    <ScreenScaffold title="Connected dApps" onBack={onBack}>
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-[12px] leading-[1.5] text-fg-muted">
          Each grant is scoped to one origin and the chains it asked for. Revoke
          anytime; the site has to ask again.
        </p>

        {grants.length === 0 ? (
          <EmptyState
            icon={<IconGlobe width={16} height={16} />}
            title="No connected dApps"
            description="Sites you approve will be listed here with the chains they can see."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {grants.map((grant) => (
              <li
                key={grant.origin}
                className={cn(
                  "flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)]",
                  "bg-[var(--z-glass)] px-3 py-3",
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex size-[30px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted">
                    <IconGlobe width={16} height={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-fg">
                      {hostOf(grant.origin)}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] text-[var(--z-success)]">
                      <span className="size-1.5 rounded-full bg-[var(--z-success)]" />
                      connected
                      {grant.expiresAt
                        ? ` · until ${new Date(grant.expiresAt).toLocaleDateString()}`
                        : ""}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void sendToBackground("REVOKE_PERMISSION", {
                        origin: grant.origin,
                      }).then(onRefresh);
                    }}
                  >
                    Revoke
                  </Button>
                </div>

                <ul className="flex flex-wrap gap-1.5">
                  {grant.chainIds.map((chainId) => (
                    <li
                      key={chainId}
                      className="rounded-full border border-[var(--z-line)] px-2 py-[3px] font-mono text-[9px] text-fg-dim"
                    >
                      {findCatalogEntry(chainId)?.chainName ?? chainId}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </ScreenScaffold>
  );
}
