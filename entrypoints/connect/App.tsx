import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Callout,
  Spinner,
  ThemeProvider,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { AccountAddress } from "../../lib/account-addresses";
import type { ApprovalRequest } from "../../lib/approvals";
import { findCatalogEntry } from "../../lib/chain-catalog";
import {
  CONNECT_OVERLAY_CHANNEL,
  originHostLabel,
  type ConnectOverlayMessage,
  type ConnectOverlayOutcome,
} from "../../lib/connect-overlay";
import { sendToBackground } from "../../lib/popup-client";
import { useExtensionState } from "../popup/hooks/useExtensionState";
import { UnlockScreen } from "../popup/screens/UnlockScreen";
import { IconCheck, IconClose } from "../popup/screens/icons";
import { APPROVAL_ID, INITIAL_THEME, parentTargetOrigin } from "./params";

/**
 * The only thing this frame tells the dApp's page. Presentation signals only —
 * approve/reject go to the background over runtime messaging, where the page
 * cannot observe or forge them.
 */
function postToParent(message: ConnectOverlayMessage): void {
  window.parent.postMessage(message, parentTargetOrigin());
}

function ModalCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-full flex-col bg-[var(--z-surface-raised)] text-fg",
        className,
      )}
    >
      {children}
    </div>
  );
}

function BrandMark() {
  return (
    <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-[image:var(--z-accent-gradient)] shadow-[var(--z-accent-glow)]">
      <img src="/brand/mark.svg" alt="" width={18} height={17} />
    </span>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Close"
      onClick={onClick}
      className={cn(
        "flex size-[26px] shrink-0 items-center justify-center rounded-full text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
        focusRing,
      )}
    >
      <IconClose width={16} height={16} />
    </button>
  );
}

function ModalHeader({
  origin,
  onClose,
}: {
  origin: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-[11px]">
      <BrandMark />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium leading-tight tracking-[-0.02em] text-fg">
          Connect Zunia
        </span>
        {/*
          The mock leaves the origin to the browser chrome. A modal drawn over
          the page has to name the site itself, otherwise an iframe on a
          look-alike domain is indistinguishable from the real thing.
        */}
        <span className="mt-[3px] block truncate font-mono text-[9.5px] text-fg-dim">
          {originHostLabel(origin)}
        </span>
      </span>
      <CloseButton onClick={onClose} />
    </div>
  );
}

function AccountRow({
  name,
  address,
  selected,
  onSelect,
}: {
  name: string;
  address: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[13px] px-3 py-[11px] text-left",
        "transition-colors duration-[var(--z-duration-base)]",
        selected
          ? "border border-[var(--z-info-line)] bg-[var(--z-info-fill)]"
          : "border border-transparent bg-[var(--z-glass)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "flex size-[26px] shrink-0 items-center justify-center rounded-full font-mono text-[10px] uppercase",
          selected
            ? "bg-[image:var(--z-accent-gradient)] text-[var(--z-accent-fg)]"
            : "bg-[var(--z-glass-2)] text-fg-muted",
        )}
      >
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium leading-tight text-fg">
          {name}
        </span>
        <span className="mt-[3px] block truncate font-mono text-[9.5px] text-fg-dim">
          {truncateAddress(address, 8, 4)}
        </span>
      </span>
      {selected ? (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--z-accent)] text-[var(--z-accent-fg)]">
          <IconCheck width={16} height={16} />
        </span>
      ) : (
        <span className="size-4 shrink-0 rounded-full border border-[var(--z-line-strong)]" />
      )}
    </button>
  );
}

function ConnectApproval({
  approval,
  accounts,
  activeIndex,
  onApprove,
  onReject,
  busy,
  error,
}: {
  approval: ApprovalRequest;
  accounts: AccountAddress[];
  activeIndex: number;
  onApprove: (accountIndex: number) => void;
  onReject: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [selected, setSelected] = useState(activeIndex);

  useEffect(() => {
    if (accounts.some((a) => a.index === selected)) return;
    const fallback = accounts.find((a) => a.index === activeIndex) ?? accounts[0];
    if (fallback) setSelected(fallback.index);
  }, [accounts, activeIndex, selected]);

  const chainNames = approval.chainIds.map(
    (id) => findCatalogEntry(id)?.chainName ?? id,
  );

  return (
    <ModalCard className="p-[22px]">
      <ModalHeader origin={approval.origin} onClose={onReject} />

      <p className="mt-3.5 text-[12px] leading-relaxed text-fg-muted">
        Choose the account this site may see. It can read balances and request
        signatures, which you approve one at a time.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {chainNames.map((chainName) => (
          <span
            key={chainName}
            className="rounded-full border border-[var(--z-line)] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.08em] text-fg-dim"
          >
            {chainName}
          </span>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Account">
        {accounts.map((account) => (
          <AccountRow
            key={account.index}
            name={account.name}
            address={account.address}
            selected={account.index === selected}
            onSelect={() => setSelected(account.index)}
          />
        ))}
      </div>

      {error ? (
        <div className="mt-3">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}

      <div className="mt-4 flex gap-2.5">
        <Button
          variant="secondary"
          size="lg"
          className="h-[42px] flex-1 text-[12.5px]"
          disabled={busy}
          onClick={onReject}
        >
          Cancel
        </Button>
        <Button
          size="lg"
          className="h-[42px] flex-1 text-[12.5px]"
          loading={busy}
          disabled={accounts.length === 0}
          onClick={() => onApprove(selected)}
        >
          Connect
        </Button>
      </div>
    </ModalCard>
  );
}

function StatusCard({
  origin,
  title,
  description,
  onClose,
}: {
  origin: string;
  title: string;
  description: string;
  onClose: () => void;
}) {
  return (
    <ModalCard className="p-[22px]">
      <ModalHeader origin={origin} onClose={onClose} />
      <p className="mt-4 text-[13px] font-medium text-fg">{title}</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-fg-muted">
        {description}
      </p>
      <Button
        size="lg"
        className="mt-4 h-[42px] w-full text-[12.5px]"
        onClick={onClose}
      >
        Close
      </Button>
    </ModalCard>
  );
}

function ConnectBody() {
  const state = useExtensionState();
  const { status, approvals, refresh } = state;
  const [accounts, setAccounts] = useState<AccountAddress[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const approval = useMemo(
    () => approvals.find((item) => item.id === APPROVAL_ID) ?? null,
    [approvals],
  );

  /**
   * Only connection prompts belong in an in-page frame. A signature or
   * broadcast request routed here by mistake is refused rather than rendered:
   * those stay in the toolbar popup, which a page cannot draw over.
   */
  const wrongKind = approval !== null && approval.kind !== "enable";

  const finish = useCallback((outcome: ConnectOverlayOutcome) => {
    setFinished(true);
    postToParent({
      channel: CONNECT_OVERLAY_CHANNEL,
      action: "done",
      approvalId: APPROVAL_ID,
      outcome,
    });
  }, []);

  // Report the rendered height so the parent frame can size the iframe to the
  // card instead of guessing.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || finished) return;
    const report = () => {
      postToParent({
        channel: CONNECT_OVERLAY_CHANNEL,
        action: "resize",
        approvalId: APPROVAL_ID,
        height: Math.ceil(node.getBoundingClientRect().height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, [finished]);

  const unlocked = Boolean(status?.unlocked);
  const chainId = approval?.chainIds[0];

  useEffect(() => {
    if (!unlocked || !chainId) return;
    let cancelled = false;
    void sendToBackground<AccountAddress[]>("GET_ACCOUNT_ADDRESSES", { chainId })
      .then((rows) => {
        if (!cancelled) setAccounts(rows);
      })
      .catch(() => {
        // Fall back to the stored (cosmos-prefixed) addresses below.
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, chainId]);

  const accountRows: AccountAddress[] = useMemo(() => {
    if (accounts.length > 0) return accounts;
    return (status?.accounts ?? []).map((account) => ({
      index: account.index,
      name: account.name,
      address: account.address,
    }));
  }, [accounts, status]);

  const approve = useCallback(
    async (accountIndex: number) => {
      setBusy(true);
      setError(null);
      try {
        if (accountIndex !== status?.activeAccountIndex) {
          await sendToBackground("SET_ACTIVE_ACCOUNT", { index: accountIndex });
        }
        await sendToBackground("RESOLVE_APPROVAL", {
          id: APPROVAL_ID,
          result: { approved: true },
        });
        finish("approved");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [finish, status?.activeAccountIndex],
  );

  const reject = useCallback(async () => {
    setBusy(true);
    try {
      await sendToBackground("REJECT_APPROVAL", {
        id: APPROVAL_ID,
        reason: "User rejected",
      });
    } catch {
      // Already gone from the queue; tearing down still settles the dApp.
    }
    finish("rejected");
  }, [finish]);

  // A page cannot key into this frame, but Escape inside it should still close.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) void reject();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, reject]);

  let body: React.ReactNode;

  if (finished) {
    body = null;
  } else if (!status) {
    body = (
      <ModalCard className="items-center justify-center gap-2 p-[22px] py-10 text-fg-dim">
        <Spinner />
        <span className="text-[12px]">Opening Zunia…</span>
      </ModalCard>
    );
  } else if (!status.hasWallet) {
    body = (
      <StatusCard
        origin={approval?.origin ?? window.location.origin}
        title="No wallet on this device"
        description="Set up Zunia from the toolbar icon, then try connecting again."
        onClose={() => void reject()}
      />
    );
  } else if (!status.unlocked) {
    // Locked: the unlock form comes first, then the approval renders in place.
    body = (
      <ModalCard className="h-[430px]">
        <UnlockScreen
          autoLockMs={status.autoLockMs}
          onUnlocked={() => void refresh()}
          onForgot={() => {
            // Recovery needs the full-size UI; the frame cannot host it.
            void browser.tabs.create({
              url: browser.runtime.getURL("/popup.html" as never),
            });
            finish("dismissed");
          }}
        />
      </ModalCard>
    );
  } else if (!approval || wrongKind) {
    body = (
      <StatusCard
        origin={approval?.origin ?? window.location.origin}
        title="Request no longer pending"
        description="This connection request expired or was already answered. Ask the site to try again."
        onClose={() => finish("dismissed")}
      />
    );
  } else {
    body = (
      <ConnectApproval
        approval={approval}
        accounts={accountRows}
        activeIndex={status.activeAccountIndex}
        busy={busy}
        error={error}
        onApprove={(index) => void approve(index)}
        onReject={() => void reject()}
      />
    );
  }

  return <div ref={rootRef}>{body}</div>;
}

export default function ConnectApp() {
  return (
    <ThemeProvider defaultTheme={INITIAL_THEME} storageKey="zunia.theme">
      <ConnectBody />
    </ThemeProvider>
  );
}
