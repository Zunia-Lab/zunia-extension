import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  PopupShell,
  ScreenScaffold,
  Spinner,
  ThemeProvider,
} from "@zunialab/ui";
import { SESSION_CONFIG } from "../../config/session";
import { watchUserActivity } from "../../lib/activity";
import type { AddressBookEntry } from "../../lib/address-book";
import { closeApprovalSurface } from "../../lib/approval-ui";
import { sendToBackground } from "../../lib/popup-client";
import { hasLiveBalancePermission } from "../../lib/balances";
import { useExtensionState } from "./hooks/useExtensionState";
import { useChainAccounts } from "./hooks/useChainAccounts";
import { useBalances } from "./hooks/useBalances";
import { usePrices } from "./hooks/usePrices";
import { PrefsProvider } from "./state/Prefs";
import { SigningPasswordProvider } from "./state/SigningPassword";
import { ToastProvider } from "./state/Toasts";
import { BottomNav } from "./components/BottomNav";
import { MoreDrawer } from "./components/MoreDrawer";
import {
  isTabRoute,
  pushLocation,
  withEarnPick,
  type PopupLocation,
  type PopupRoute,
} from "./routes";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { CreateWalletScreen } from "./screens/CreateWalletScreen";
import { ImportWalletScreen } from "./screens/ImportWalletScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { ForgotPasswordScreen } from "./screens/ForgotPasswordScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { EarnScreen } from "./screens/EarnScreen";
import { SwapScreen } from "./screens/SwapScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { ChainDetailScreen } from "./screens/ChainDetailScreen";
import { TxDetailScreen } from "./screens/TxDetailScreen";
import { ValidatorDetailScreen } from "./screens/ValidatorDetailScreen";
import { SendScreen } from "./screens/SendScreen";
import { ReceiveScreen } from "./screens/ReceiveScreen";
import { NetworksScreen } from "./screens/NetworksScreen";
import { AddChainScreen } from "./screens/AddChainScreen";
import { NftScreen } from "./screens/NftScreen";
import { NftDetailScreen } from "./screens/NftDetailScreen";
import { GovernanceScreen } from "./screens/GovernanceScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { useRealtime } from "./hooks/useWalletEvents";
import { AddressBookScreen } from "./screens/AddressBookScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SecurityScreen } from "./screens/SecurityScreen";
import { PreferencesScreen } from "./screens/PreferencesScreen";
import { WalletsScreen } from "./screens/WalletsScreen";
import { AddAccountScreen } from "./screens/AddAccountScreen";
import { RevealPhraseScreen } from "./screens/RevealPhraseScreen";
import { ConnectedSitesScreen } from "./screens/ConnectedSitesScreen";
import { ApproveScreen } from "./screens/ApproveScreen";
import type { ActivityItem, ValidatorInfo } from "../../lib/chain-queries";
import type { PendingTransfer } from "../../lib/pending-transfers";

/** Routes reachable only once the wallet is unlocked. */
const UNLOCKED_ROUTES: PopupRoute[] = [
  "home",
  "earn",
  "swap",
  "activity",
  "chain",
  "tx",
  "validator",
  "send",
  "receive",
  "networks",
  "add-chain",
  "nft",
  "nft-token",
  "governance",
  "notifications",
  "address-book",
  "settings",
  "security",
  "preferences",
  "wallets",
  "add-account",
  "add-create",
  "add-import",
  "reveal",
  "sites",
  "approve",
];

function initialRouteFromUrl(): PopupRoute | null {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("approve") === "1") return "approve";
  } catch {
    // Popup opened without a query string.
  }
  return null;
}

type ExtensionState = ReturnType<typeof useExtensionState>;

/** A view opened without the data it shows, e.g. after the popup reloaded. */
function Unavailable({
  title,
  description,
  onBack,
}: {
  title: string;
  description: string;
  onBack: () => void;
}) {
  return (
    <ScreenScaffold title={title} onBack={onBack}>
      <div className="pt-6">
        <EmptyState
          title={`${title} unavailable`}
          description={description}
          action={
            <Button size="sm" onClick={onBack}>
              Go back
            </Button>
          }
        />
      </div>
    </ScreenScaffold>
  );
}

/** Stable identity for the empty address book. */
const NO_CONTACTS: AddressBookEntry[] = [];

function AppBody({ state }: { state: ExtensionState }) {
  const { status, settings, approvals, grants, error, loading, refresh } =
    state;
  // The worker's unread count, the same number as the toolbar badge, so the
  // bell inside the wallet says where that badge points. Pending approvals
  // count as notices; before the worker's first feed arrives they still show.
  const realtime = useRealtime();
  const noticeCount = Math.max(realtime.unread, approvals.length);
  // Where the user has been, newest last. Back pops; the bottom bar and the
  // end of a flow start over. Empty means the default screen for the state.
  const [history, setHistory] = useState<PopupLocation[]>(() => {
    const route = initialRouteFromUrl();
    return route ? [{ route }] : [];
  });
  const override = history[history.length - 1] ?? null;
  // When the user last navigated. A dApp request newer than that takes over the
  // screen; an older one waits until the user comes back to it.
  const [navigatedAt, setNavigatedAt] = useState(0);
  const navigate = useCallback((next: PopupLocation) => {
    setHistory((prev) => pushLocation(prev, next));
    setNavigatedAt(Date.now());
  }, []);
  const resetTo = useCallback((next: PopupLocation | null) => {
    setHistory(next ? pushLocation([], next) : []);
    setNavigatedAt(Date.now());
  }, []);
  const back = useCallback(() => {
    setHistory((prev) => prev.slice(0, -1));
    setNavigatedAt(Date.now());
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [contacts, setContacts] = useState<AddressBookEntry[]>(NO_CONTACTS);

  const unlocked = Boolean(status?.unlocked);
  useEffect(() => {
    if (!unlocked) return;
    return watchUserActivity(
      window,
      () => void sendToBackground("TOUCH_SESSION").catch(() => undefined),
      SESSION_CONFIG.autoLock.activityReportMs,
    );
  }, [unlocked]);
  const {
    accounts: chains,
    chainIds,
    loading: chainsLoading,
    reload: reloadChains,
  } = useChainAccounts(unlocked, status?.activeAccountIndex ?? 0);
  const [hostGranted, setHostGranted] = useState(false);
  const markHostGranted = useCallback(() => setHostGranted(true), []);
  useEffect(() => {
    // A locked popup never reads balances (`liveReads` below gates on
    // `unlocked`), so there is nothing to clear here. The old
    // `setHostGranted(false)` was a synchronous setState inside the effect that
    // re-rendered every screen a second time on each lock and unlock. The check
    // re-runs on unlock and writes the real answer, false included.
    if (!unlocked) return;
    let cancelled = false;
    void hasLiveBalancePermission().then((granted) => {
      if (!cancelled) setHostGranted(granted);
    });
    return () => {
      cancelled = true;
    };
  }, [unlocked, settings?.liveBalances]);
  const liveReads =
    unlocked && Boolean(settings?.liveBalances) && hostGranted;
  const {
    balances,
    loading: balancesLoading,
    reload: reloadBalances,
  } = useBalances(chainIds, liveReads, status?.activeAccountIndex ?? 0);
  const { prices, reload: reloadPrices } = usePrices(chainIds, liveReads);

  // Bumped by the screens that write the address book, so the list reloads
  // without the effect below having to setState synchronously to trigger it.
  const [contactsToken, setContactsToken] = useState(0);
  const loadContacts = useCallback(() => {
    setContactsToken((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    sendToBackground<AddressBookEntry[]>("LIST_ADDRESS_BOOK")
      .then((rows) => {
        if (!cancelled) setContacts(rows);
      })
      .catch(() => {
        if (!cancelled) setContacts(NO_CONTACTS);
      });
    return () => {
      cancelled = true;
    };
  }, [unlocked, contactsToken]);

  const newestApprovalAt = approvals.reduce(
    (latest, item) => Math.max(latest, item.createdAt),
    0,
  );

  const location: PopupLocation = useMemo(() => {
    if (override?.route === "create" || override?.route === "import") {
      return override;
    }
    if (loading || !status) return { route: "boot" };
    if (!status.hasWallet) return { route: "welcome" };
    if (!status.unlocked) {
      return override?.route === "forgot-password"
        ? override
        : { route: "unlock" };
    }
    if (override && UNLOCKED_ROUTES.includes(override.route)) {
      if (approvals.length > 0 && newestApprovalAt > navigatedAt) {
        return { route: "approve" };
      }
      return override;
    }
    if (approvals.length > 0) return { route: "approve" };
    return { route: "home" };
  }, [loading, status, override, approvals.length, newestApprovalAt, navigatedAt]);

  const route = location.route;

  const go = useCallback(
    (next: PopupRoute, chainId?: string) => navigate({ route: next, chainId }),
    [navigate],
  );

  const openTx = useCallback(
    (item: ActivityItem, transfer?: PendingTransfer) => {
      navigate({
        route: "tx",
        chainId: item.chainId,
        hash: item.hash,
        tx: item,
        ...(transfer ? { transfer } : {}),
      });
    },
    [navigate],
  );

  const openValidator = useCallback(
    (validator: ValidatorInfo) => {
      navigate({
        route: "validator",
        chainId: validator.chainId,
        operatorAddress: validator.operatorAddress,
        validator,
      });
    },
    [navigate],
  );

  const rememberEarnPick = useCallback(
    (chainId: string, operatorAddress: string | null) => {
      setHistory((prev) => withEarnPick(prev, chainId, operatorAddress));
    },
    [],
  );

  // Earn is a tab root, so this starts a fresh history on it with the
  // validator already picked for the Delegate button.
  const stakeWith = useCallback(
    (validator: ValidatorInfo) => {
      navigate({
        route: "earn",
        chainId: validator.chainId,
        operatorAddress: validator.operatorAddress,
      });
    },
    [navigate],
  );

  const openChain = useCallback(
    (chainId: string) => navigate({ route: "chain", chainId }),
    [navigate],
  );

  // A CW721 token is identified by three things, so all three travel in the
  // location: a token id is unique only inside its contract, and a contract
  // address is only meaningful on its own chain.
  const openNftToken = useCallback(
    (input: { chainId: string; collectionAddress: string; tokenId: string }) => {
      navigate({
        route: "nft-token",
        chainId: input.chainId,
        collectionAddress: input.collectionAddress,
        tokenId: input.tokenId,
      });
    },
    [navigate],
  );

  const activeAccount = status?.accounts.find(
    (a) => a.index === status.activeAccountIndex,
  );
  const selectedChain = chains.find((c) => c.chainId === location.chainId);

  const showTabs = isTabRoute(route);

  const shell = (children: React.ReactNode) => (
    <>
      {children}
      {showTabs ? (
        <BottomNav value={route} onChange={(next) => resetTo({ route: next })} />
      ) : null}
    </>
  );

  return (
    <PopupShell showChrome={false} className={showTabs ? undefined : "zunia-fit"}>
      {error ? (
        <div className="px-4 pt-3">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}

      {route === "boot" ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-dim">
          <Spinner />
          <span className="text-[12px]">Opening wallet…</span>
        </div>
      ) : null}

      {route === "welcome" ? (
        <WelcomeScreen
          onCreate={() => go("create")}
          onImport={() => go("import")}
        />
      ) : null}

      {route === "create" ? (
        <CreateWalletScreen
          onBack={back}
          onDone={() => {
            resetTo(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "import" ? (
        <ImportWalletScreen
          onBack={back}
          onDone={() => {
            resetTo(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "unlock" && status ? (
        <UnlockScreen
          autoLockMs={status.autoLockMs}
          onForgot={() => go("forgot-password")}
          onUnlocked={() => {
            resetTo(
              approvals.length > 0 || initialRouteFromUrl() === "approve"
                ? { route: "approve" }
                : null,
            );
            void refresh();
          }}
        />
      ) : null}

      {route === "forgot-password" ? (
        <ForgotPasswordScreen
          onBack={back}
          onRemoved={() => {
            resetTo(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "home" && status
        ? shell(
            <HomeScreen
              status={status}
              pendingCount={noticeCount}
              grants={grants}
              chains={chains}
              balances={balances}
              prices={prices}
              balancesLoading={balancesLoading || chainsLoading}
              hostGranted={hostGranted}
              onHostGranted={markHostGranted}
              onReloadBalances={() => {
                void reloadBalances(true);
                void reloadPrices(true);
              }}
              onNavigate={(next) => go(next)}
              onOpenChain={openChain}
              onOpenEarn={(chainId) => go("earn", chainId)}
              onOpenTx={openTx}
              onOpenMenu={() => setMenuOpen(true)}
              onRefresh={() => void refresh()}
            />,
          )
        : null}

      {route === "earn"
        ? shell(
            <EarnScreen
              chains={chains}
              balances={balances}
              initialChainId={location.chainId}
              initialValidator={location.operatorAddress}
              onOpenChain={(chainId) => go("chain", chainId)}
              onOpenValidator={openValidator}
              onSelectionChange={rememberEarnPick}
              onRefreshBalances={() => {
                void reloadBalances(true);
              }}
            />,
          )
        : null}

      {route === "swap"
        ? shell(
            <SwapScreen
              chains={chains}
              balances={balances}
              initialChainId={location.chainId}
            />,
          )
        : null}

      {route === "activity"
        ? shell(
            <ActivityScreen
              chains={chains}
              balances={balances}
              initialChainId={location.chainId}
              onOpenTx={openTx}
            />,
          )
        : null}

      {route === "tx" ? (
        location.tx ? (
          <TxDetailScreen
            item={location.tx}
            transfer={location.transfer}
            balances={balances}
            onOpenSwap={() => go("swap")}
            onBack={back}
          />
        ) : (
          <Unavailable
            title="Transaction"
            description="Open it again from Activity to see its details."
            onBack={back}
          />
        )
      ) : null}

      {route === "validator" ? (
        location.validator ? (
          <ValidatorDetailScreen
            validator={location.validator}
            onBack={back}
            onStake={stakeWith}
            onOpenChain={openChain}
          />
        ) : (
          <Unavailable
            title="Validator"
            description="Open it again from Earn to see its details."
            onBack={back}
          />
        )
      ) : null}

      {route === "chain" ? (
        selectedChain ? (
          <ChainDetailScreen
            chain={selectedChain}
            balance={balances[selectedChain.chainId]}
            price={prices[selectedChain.chainId]}
            loading={balancesLoading || chainsLoading}
            onBack={back}
            onNavigate={(next, chainId) => go(next, chainId)}
            onOpenTx={openTx}
          />
        ) : (
          // A chain can disappear while its page is open (disabled in Networks,
          // custom chain removed), so never leave the popup blank.
          <ScreenScaffold title="Network" onBack={back}>
            <div className="pt-6">
              <EmptyState
                title="Network unavailable"
                description="This chain is no longer enabled for this wallet. Turn it back on from Networks."
                action={
                  <Button size="sm" onClick={() => go("networks")}>
                    Manage networks
                  </Button>
                }
              />
            </div>
          </ScreenScaffold>
        )
      ) : null}

      {route === "send" ? (
        <SendScreen
          key={`${location.chainId ?? ""}:${location.sendMode ?? "send"}`}
          chains={chains}
          balances={balances}
          initialChainId={location.chainId}
          initialMode={location.sendMode === "cross" ? "cross" : "send"}
          contacts={contacts}
          onContactsChanged={loadContacts}
          onBack={back}
          onOpenNfts={() => go("nft")}
        />
      ) : null}

      {route === "receive" && status ? (
        <ReceiveScreen
          status={status}
          initialChainId={location.chainId}
          onBack={back}
        />
      ) : null}

      {route === "networks" ? (
        <NetworksScreen
          accountName={
            status?.accounts.find(
              (row) => row.index === status.activeAccountIndex,
            )?.name
          }
          onBack={back}
          onAddChain={() => go("add-chain")}
          onSaved={() => {
            resetTo(null);
            void refresh();
            void reloadChains().then(() => {
              void reloadBalances(true);
              void reloadPrices(true);
            });
          }}
        />
      ) : null}

      {route === "add-chain" ? (
        <AddChainScreen
          onBack={() => {
            void reloadChains().then(() => {
              void reloadBalances(true);
              void reloadPrices(true);
            });
            back();
          }}
          onSaved={() => {
            void reloadChains().then(() => {
              void reloadBalances(true);
              void reloadPrices(true);
            });
            back();
          }}
        />
      ) : null}

      {route === "nft" ? (
        <NftScreen
          chains={chains}
          initialChainId={location.chainId}
          onBack={back}
          onOpenToken={openNftToken}
          onNavigate={(next) => go(next)}
        />
      ) : null}

      {route === "nft-token" ? (
        location.chainId && location.collectionAddress && location.tokenId ? (
          <NftDetailScreen
            chainId={location.chainId}
            collectionAddress={location.collectionAddress}
            tokenId={location.tokenId}
            chains={chains}
            contacts={contacts}
            onContactsChanged={loadContacts}
            onBack={back}
          />
        ) : (
          <Unavailable
            title="NFT"
            description="Open it again from your collection to see it."
            onBack={back}
          />
        )
      ) : null}

      {route === "governance" ? (
        <GovernanceScreen chains={chains} onBack={back} />
      ) : null}

      {route === "notifications" ? (
        <NotificationsScreen
          approvals={approvals}
          chains={chains}
          balances={balances}
          onBack={back}
          onNavigate={(next, chainId) => go(next, chainId)}
        />
      ) : null}

      {route === "address-book" ? (
        <AddressBookScreen
          contacts={contacts}
          chains={chains}
          onBack={back}
          onChanged={loadContacts}
        />
      ) : null}

      {route === "settings" && status ? (
        <SettingsScreen
          status={status}
          grants={grants}
          contactCount={contacts.length}
          onBack={back}
          onNavigate={(next) => go(next)}
          onRefresh={() => void refresh()}
        />
      ) : null}

      {route === "security" && status ? (
        <SecurityScreen
          autoLockMs={status.autoLockMs}
          grantCount={grants.length}
          onBack={back}
          onNavigate={(next) => go(next)}
          onRemoved={() => {
            resetTo(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "preferences" ? <PreferencesScreen onBack={back} /> : null}

      {route === "wallets" && status ? (
        <WalletsScreen
          status={status}
          onBack={back}
          onRefresh={() => void refresh()}
          onAdd={() => go("add-account")}
        />
      ) : null}

      {route === "add-account" ? (
        <AddAccountScreen
          onBack={back}
          onCreate={() => go("add-create")}
          onRestore={() => go("add-import")}
        />
      ) : null}

      {route === "add-create" ? (
        <CreateWalletScreen
          variant="add"
          onBack={back}
          onDone={() => {
            resetTo({ route: "wallets" });
            void refresh();
          }}
        />
      ) : null}

      {route === "add-import" ? (
        <ImportWalletScreen
          variant="add"
          onBack={back}
          onDone={() => {
            resetTo({ route: "wallets" });
            void refresh();
          }}
        />
      ) : null}

      {route === "reveal" ? <RevealPhraseScreen onBack={back} /> : null}

      {route === "sites" ? (
        <ConnectedSitesScreen
          grants={grants}
          onBack={back}
          onRefresh={() => void refresh()}
        />
      ) : null}

      {route === "approve" && status ? (
        <ApproveScreen
          approvals={approvals}
          status={status}
          requirePassword={Boolean(settings?.requirePasswordOnSign)}
          onDone={(answeredId) => {
            void refresh();
            // Leaving an empty queue, without answering one, returns to the wallet.
            if (!answeredId) {
              if (override?.route === "approve") back();
              else setNavigatedAt(Date.now());
              return;
            }
            // More requests queued: stay here and show the next one.
            if (approvals.some((item) => item.id !== answeredId)) return;
            // The popup was opened to answer this site. Close it once the queue is done.
            void closeApprovalSurface();
          }}
        />
      ) : null}

      <MoreDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        account={activeAccount}
        networkCount={chainIds.length}
        sessionCount={grants.length}
        pendingCount={noticeCount}
        onNavigate={(next) => go(next)}
        onLock={() => {
          void sendToBackground("LOCK").then(refresh);
        }}
      />
    </PopupShell>
  );
}

export default function App() {
  const state = useExtensionState();

  return (
    <ThemeProvider
      defaultTheme={state.settings?.theme ?? "dark"}
      storageKey="zunia.theme"
    >
      <PrefsProvider
        settings={state.settings}
        onChanged={() => void state.refresh()}
      >
        <SigningPasswordProvider
          required={Boolean(state.settings?.requirePasswordOnSign)}
        >
          <ToastProvider>
            <AppBody state={state} />
          </ToastProvider>
        </SigningPasswordProvider>
      </PrefsProvider>
    </ThemeProvider>
  );
}
