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
import type { AddressBookEntry } from "../../lib/address-book";
import { sendToBackground } from "../../lib/popup-client";
import { useExtensionState } from "./hooks/useExtensionState";
import { useChainAccounts } from "./hooks/useChainAccounts";
import { useBalances } from "./hooks/useBalances";
import { usePrices } from "./hooks/usePrices";
import { PrefsProvider } from "./state/Prefs";
import { BottomNav } from "./components/BottomNav";
import { MoreDrawer } from "./components/MoreDrawer";
import {
  PARENT_ROUTE,
  isTabRoute,
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
import { SendScreen } from "./screens/SendScreen";
import { ReceiveScreen } from "./screens/ReceiveScreen";
import { NetworksScreen } from "./screens/NetworksScreen";
import { AddChainScreen } from "./screens/AddChainScreen";
import { BridgeScreen } from "./screens/BridgeScreen";
import { GovernanceScreen } from "./screens/GovernanceScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { AddressBookScreen } from "./screens/AddressBookScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { SecurityScreen } from "./screens/SecurityScreen";
import { PreferencesScreen } from "./screens/PreferencesScreen";
import { WalletsScreen } from "./screens/WalletsScreen";
import { RevealPhraseScreen } from "./screens/RevealPhraseScreen";
import { ConnectedSitesScreen } from "./screens/ConnectedSitesScreen";
import { ApproveScreen } from "./screens/ApproveScreen";

/** Routes reachable only once the wallet is unlocked. */
const UNLOCKED_ROUTES: PopupRoute[] = [
  "home",
  "earn",
  "swap",
  "activity",
  "chain",
  "send",
  "receive",
  "networks",
  "add-chain",
  "bridge",
  "governance",
  "notifications",
  "address-book",
  "settings",
  "security",
  "preferences",
  "wallets",
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

function AppBody({ state }: { state: ExtensionState }) {
  const { status, settings, approvals, grants, error, loading, refresh } =
    state;
  const [override, setOverride] = useState<PopupLocation | null>(() => {
    const route = initialRouteFromUrl();
    return route ? { route } : null;
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [contacts, setContacts] = useState<AddressBookEntry[]>([]);

  const unlocked = Boolean(status?.unlocked);
  const {
    accounts: chains,
    chainIds,
    reload: reloadChains,
  } = useChainAccounts(unlocked, status?.activeAccountIndex ?? 0);
  const liveReads = unlocked && Boolean(settings?.liveBalances);
  const {
    balances,
    loading: balancesLoading,
    reload: reloadBalances,
  } = useBalances(chainIds, liveReads);
  const { prices, reload: reloadPrices } = usePrices(chainIds, liveReads);

  const loadContacts = useCallback(async () => {
    try {
      setContacts(
        await sendToBackground<AddressBookEntry[]>("LIST_ADDRESS_BOOK"),
      );
    } catch {
      setContacts([]);
    }
  }, []);

  useEffect(() => {
    if (unlocked) void loadContacts();
  }, [unlocked, loadContacts]);

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
    if (override && UNLOCKED_ROUTES.includes(override.route)) return override;
    if (approvals.length > 0) return { route: "approve" };
    return { route: "home" };
  }, [loading, status, override, approvals.length]);

  const route = location.route;

  const go = useCallback((next: PopupRoute | null, chainId?: string) => {
    setOverride(next ? { route: next, chainId } : null);
  }, []);

  const back = useCallback(() => {
    const parent = PARENT_ROUTE[route] ?? "home";
    setOverride(parent === "home" ? null : { route: parent });
  }, [route]);

  const activeAccount = status?.accounts.find(
    (a) => a.index === status.activeAccountIndex,
  );
  const selectedChain = chains.find((c) => c.chainId === location.chainId);

  const showTabs = isTabRoute(route);

  const shell = (children: React.ReactNode) => (
    <>
      {children}
      {showTabs ? (
        <BottomNav value={route} onChange={(next) => go(next)} />
      ) : null}
    </>
  );

  return (
    <PopupShell showChrome={false}>
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
          onBack={() => go(null)}
          onDone={() => {
            go(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "import" ? (
        <ImportWalletScreen
          onBack={() => go(null)}
          onDone={() => {
            go(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "unlock" && status ? (
        <UnlockScreen
          autoLockMs={status.autoLockMs}
          onForgot={() => go("forgot-password")}
          onUnlocked={() => {
            go(
              approvals.length > 0 || initialRouteFromUrl() === "approve"
                ? "approve"
                : null,
            );
            void refresh();
          }}
        />
      ) : null}

      {route === "forgot-password" ? (
        <ForgotPasswordScreen
          onBack={() => go(null)}
          onRemoved={() => {
            go(null);
            void refresh();
          }}
        />
      ) : null}

      {route === "home" && status
        ? shell(
            <HomeScreen
              status={status}
              pendingCount={approvals.length}
              grants={grants}
              chains={chains}
              balances={balances}
              prices={prices}
              balancesLoading={balancesLoading}
              onReloadBalances={() => {
                void reloadBalances(true);
                void reloadPrices(true);
              }}
              onNavigate={(next) => go(next)}
              onOpenChain={(chainId) => go("chain", chainId)}
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
              onOpenChain={(chainId) => go("chain", chainId)}
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
              onOpenChain={(chainId) => go("chain", chainId)}
            />,
          )
        : null}

      {route === "chain" ? (
        selectedChain ? (
          <ChainDetailScreen
            chain={selectedChain}
            balance={balances[selectedChain.chainId]}
            price={prices[selectedChain.chainId]}
            loading={balancesLoading}
            onBack={back}
            onNavigate={(next, chainId) => go(next, chainId)}
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
          chains={chains}
          balances={balances}
          initialChainId={location.chainId}
          contacts={contacts}
          onBack={back}
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
          onBack={back}
          onAddChain={() => go("add-chain")}
          onSaved={() => {
            go(null);
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

      {route === "bridge" ? (
        <BridgeScreen chains={chains} balances={balances} onBack={back} />
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
          onBack={back}
          onChanged={() => void loadContacts()}
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
            go(null);
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
          onDone={() => {
            go(null);
            void refresh();
          }}
        />
      ) : null}

      <MoreDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        account={activeAccount}
        networkCount={chainIds.length}
        sessionCount={grants.length}
        pendingCount={approvals.length}
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
        <AppBody state={state} />
      </PrefsProvider>
    </ThemeProvider>
  );
}
