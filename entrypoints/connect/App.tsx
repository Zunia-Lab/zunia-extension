import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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

/** Accessible name of the dialog. Every state below renders a title with this id. */
const MODAL_TITLE_ID = "zunia-connect-title";

/**
 * Tab stops inside the frame, in DOM order.
 *
 * `tabIndex >= 0` rather than a `:not([tabindex="-1"])` selector: the account
 * rows are real buttons carrying a roving `tabindex="-1"`, and treating one of
 * those as the last stop would wrap focus in the wrong place.
 */
function tabbableElements(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    "a[href], button, input, select, textarea, [tabindex]",
  );
  return Array.from(candidates).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.hasAttribute("disabled") &&
      el.getClientRects().length > 0,
  );
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
        <span
          id={MODAL_TITLE_ID}
          className="block text-[15px] font-medium leading-tight tracking-[-0.02em] text-fg"
        >
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
  tabbable,
  onSelect,
  onKeyDown,
}: {
  name: string;
  address: string;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
  /**
   * Arrow-key roving lives on the radio itself rather than on the radiogroup
   * container. Same behaviour (the container only ever saw these events by
   * bubbling from here), but the element carrying the handler is a real button,
   * so the group does not need a tabindex it should not have.
   */
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
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
  const [picked, setPicked] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const noAccountsId = useId();

  // Derived, never synced from an effect. The list can change under the prompt
  // (the chain-scoped addresses resolve after the stored ones), and an effect
  // that reconciles a stale pick leaves one committed render where `selected`
  // still names an account the user is no longer being offered — which is the
  // index the Connect button would have sent.
  const selected =
    picked !== null && accounts.some((a) => a.index === picked)
      ? picked
      : accounts.some((a) => a.index === activeIndex)
        ? activeIndex
        : (accounts[0]?.index ?? activeIndex);

  const chainNames = approval.chainIds.map(
    (id) => findCatalogEntry(id)?.chainName ?? id,
  );

  // Position of the one row that is in the tab order. Falls back to the first
  // row so the group is always reachable even when the list is empty.
  const focusedPosition = Math.max(
    0,
    accounts.findIndex((account) => account.index === selected),
  );

  /**
   * Radiogroup keyboard contract: one tab stop for the whole group, arrows
   * move between rows. With a long list this is also what keeps Connect two
   * Tab presses away instead of eleven.
   */
  const onRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0 || accounts.length === 0) return;
    event.preventDefault();

    const next = (focusedPosition + step + accounts.length) % accounts.length;
    const account = accounts[next];
    if (!account) return;
    setPicked(account.index);
    // Bound to a name first: `expr\n  ?.querySelectorAll(...)\n  [next]` parses
    // as a computed member access on the previous line, not a new statement.
    const rows =
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    // Also scrolls the row into view inside the bounded list.
    rows?.[next]?.focus();
  };

  return (
    // Bottom padding moves to the action row, which owns it so that the row can
    // sit flush with the frame edge once it pins.
    <ModalCard className="px-[22px] pb-0 pt-[22px]">
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

      {/*
        The list is the only part of the card allowed to grow with the number
        of accounts. Everything the decision needs — the origin, the chains and
        the two buttons — stays outside it, so a wallet with twenty accounts
        prompts exactly like a wallet with two.
      */}
      <div
        ref={listRef}
        // -mx-px/px-px: the scroller clips both axes, and without a 1px gutter
        // it would eat the rows' focus ring at the left and right edges.
        className="-mx-px mt-4 flex max-h-[220px] flex-col gap-2 overflow-y-auto overscroll-contain px-px"
        role="radiogroup"
        aria-label="Account"
      >
        {accounts.length === 0 ? (
          <p
            id={noAccountsId}
            className="rounded-[13px] bg-[var(--z-glass)] px-3 py-[11px] text-[12px] leading-relaxed text-fg-muted"
          >
            No account is available for this network yet, so there is nothing to
            connect. Open Zunia from the toolbar to add one, then ask the site
            to try again.
          </p>
        ) : (
          accounts.map((account, position) => (
            <AccountRow
              key={account.index}
              name={account.name}
              address={account.address}
              selected={account.index === selected}
              tabbable={position === focusedPosition}
              onSelect={() => setPicked(account.index)}
              onKeyDown={onRowKeyDown}
            />
          ))
        )}
      </div>

      {/*
        Sticky, not fixed: at the common short-list size this sits where it
        always did. It only pins when the parent has clamped the frame shorter
        than the card, which is the case where these buttons used to be
        unreachable and `enable()` could only be settled by rejecting.

        The failure Callout lives inside the sticky region rather than above it.
        On a clamped frame the card is already taller than the iframe, so an
        error rendered outside this region is drawn entirely below the fold and
        nothing scrolls it into view: the button just stops spinning and the
        request looks like it silently did nothing.
      */}
      <div className="sticky bottom-0 mt-4 bg-[var(--z-surface-raised)] pb-[22px]">
        {error ? (
          <div className="mb-3">
            <Callout tone="danger">{error}</Callout>
          </div>
        ) : null}
        <div className="flex gap-2.5">
          <Button
            variant="secondary"
            size="lg"
            className="h-[42px] flex-1 text-[12.5px]"
            disabled={busy}
            onClick={onReject}
          >
            Cancel
          </Button>
          {/*
            No `title` here: Button composes `disabled:pointer-events-none`, so a
            disabled control never receives hover and the browser never renders
            its tooltip. The reason is carried by the paragraph in the list
            above, which is visible, and by aria-describedby, which reaches a
            screen reader.
          */}
          <Button
            size="lg"
            className="h-[42px] flex-1 text-[12.5px]"
            loading={busy}
            disabled={accounts.length === 0}
            aria-describedby={
              accounts.length === 0 ? noAccountsId : undefined
            }
            onClick={() => onApprove(selected)}
          >
            Connect
          </Button>
        </div>
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

  /**
   * Report the rendered height so the parent can size the iframe to the card
   * instead of guessing.
   *
   * This is the card's own bounded height, not the height of every account the
   * wallet holds: the list has its own scroller, so the number stays under the
   * frame ceiling for any account count. The parent still clamps it against the
   * viewport, and a frame clamped shorter than the card is handled here by the
   * document scrolling with the action row pinned — never by clipping it.
   */
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

  /**
   * One outcome per prompt. `busy` disables Cancel and Connect while a decision
   * is in flight, but the header's close control is not disabled by it and
   * Escape still reaches the frame — so a second reject could post "rejected"
   * to the page on top of an "approved" that had already gone out. A ref rather
   * than state, so both callbacks keep the identities their dependency arrays
   * claim.
   */
  const settling = useRef(false);

  // Read out of `status` here rather than inside the callback: with
  // `status?.activeAccountIndex` written in the dependency array the compiler
  // infers the whole of `status` as the real dependency, cannot reconcile that
  // with the narrower one written by hand, and bails out of optimising the
  // entire component.
  const activeAccountIndex = status?.activeAccountIndex;

  const approve = useCallback(
    async (accountIndex: number) => {
      if (settling.current) return;
      settling.current = true;
      setBusy(true);
      setError(null);
      try {
        if (accountIndex !== activeAccountIndex) {
          await sendToBackground("SET_ACTIVE_ACCOUNT", { index: accountIndex });
        }
        await sendToBackground("RESOLVE_APPROVAL", {
          id: APPROVAL_ID,
          result: { approved: true },
        });
        finish("approved");
      } catch (err) {
        // Nothing was settled, so let the user retry or cancel.
        settling.current = false;
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [finish, activeAccountIndex],
  );

  const reject = useCallback(async () => {
    if (settling.current) return;
    settling.current = true;
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

  /**
   * Move focus into the frame, then keep it there.
   *
   * `aria-modal` only silences the rest of *this* document, and this document
   * is an iframe: the dApp page behind the scrim keeps every one of its own tab
   * stops. Tabbing past the last control here would hand focus to the page,
   * leaving a modal prompt open with the keyboard somewhere else entirely — and
   * Escape would then reach the content script rather than this frame. The
   * container takes the initial focus rather than a button, so nothing is one
   * Enter away from being approved or rejected.
   */
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;

    node.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const stops = tabbableElements(node);
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      // -1 covers the container and the body, which is where focus sits after a
      // click on the card itself; backwards from there also leaves the frame.
      const at = stops.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && at <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && at === stops.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  let body: React.ReactNode;

  if (finished) {
    body = null;
  } else if (!status) {
    body = (
      <ModalCard className="items-center justify-center gap-2 p-[22px] py-10 text-fg-dim">
        <Spinner />
        <span id={MODAL_TITLE_ID} className="text-[12px]">
          Opening Zunia…
        </span>
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
        {/* UnlockScreen draws its own heading; the dialog still needs a name. */}
        <h2 id={MODAL_TITLE_ID} className="sr-only">
          Unlock Zunia to continue
        </h2>
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

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={MODAL_TITLE_ID}
      tabIndex={-1}
      className="outline-none"
    >
      {body}
    </div>
  );
}

export default function ConnectApp() {
  return (
    <ThemeProvider defaultTheme={INITIAL_THEME} storageKey="zunia.theme">
      <ConnectBody />
    </ThemeProvider>
  );
}
