import {
  getPendingApprovals,
  rejectApproval,
  resolveApproval,
} from "../lib/approvals";
import {
  assertInternalSender,
  isExternallyConnectableOrigin,
  type ExtensionMessage,
  type ExtensionResponse,
} from "../lib/messaging";
import {
  listActiveGrants,
  revokePermission,
} from "../lib/permissions";
import {
  handleProviderRequest,
  type ProviderMethod,
} from "../lib/provider-handler";
import {
  addAccount,
  createWallet,
  generateMnemonicPhrase,
  getAccounts,
  getChainAccounts,
  getStatus,
  importWallet,
  lockWallet,
  registerSessionLifecycle,
  renameAccount,
  resetWallet,
  revealMnemonic,
  setActiveAccount,
  touchSession,
  unlockWallet,
} from "../lib/session";
import {
  getEnabledChainIds,
  setEnabledChainIds,
} from "../lib/enabled-chains";
import { clearBalanceCache, getChainBalances } from "../lib/balances";
import { clearPriceCache, getPrices } from "../lib/prices";
import {
  hydrateCustomChains,
  listCustomChains,
  removeCustomChain,
  saveCustomChain,
  type CustomChainDraft,
} from "../lib/custom-chains";
import {
  fetchActivity,
  fetchDelegations,
  fetchProposals,
  fetchUnbonding,
  fetchValidators,
} from "../lib/chain-queries";
import {
  findIbcChannels,
  validateIbcChannel,
} from "../lib/ibc-channels";
import {
  listAddressBook,
  removeAddressBookEntry,
  saveAddressBookEntry,
} from "../lib/address-book";
import { getSettings, setSettings } from "../lib/settings";

async function routeMessage(
  message: ExtensionMessage,
  sender: {
    id?: string;
    origin?: string;
    url?: string;
    tab?: { id?: number };
  },
): Promise<ExtensionResponse> {
  try {
    const extensionId = browser.runtime.id;
    const isExternal =
      Boolean(sender.origin) &&
      sender.id !== extensionId &&
      !sender.url?.startsWith(`chrome-extension://${extensionId}`) &&
      !sender.url?.startsWith(`moz-extension://${extensionId}`);

    if (isExternal) {
      if (!sender.origin || !isExternallyConnectableOrigin(sender.origin)) {
        return { ok: false, error: "Origin not allowed" };
      }
      // External sites may only ping / limited status.
      if (message.type !== "PING" && message.type !== "GET_STATUS") {
        return { ok: false, error: "Method not allowed for external sender" };
      }
    } else if (!assertInternalSender(sender, extensionId)) {
      return { ok: false, error: "Invalid sender" };
    }

    switch (message.type) {
      case "PING":
        return { ok: true, data: { pong: true } };

      case "GET_STATUS":
        return { ok: true, data: await getStatus() };

      case "CREATE_WALLET": {
        const payload = message.payload as {
          password: string;
          wordCount?: 12 | 24;
          mnemonic?: string;
          name?: string;
          enabledChainIds?: string[];
        };
        const result = await createWallet(payload);
        return { ok: true, data: result };
      }

      case "GENERATE_MNEMONIC": {
        const payload = message.payload as { wordCount?: 12 | 24 };
        const mnemonic = await generateMnemonicPhrase(
          payload.wordCount === 24 ? 24 : 12,
        );
        return { ok: true, data: { mnemonic } };
      }

      case "IMPORT_WALLET": {
        const payload = message.payload as {
          mnemonic: string;
          password: string;
          name?: string;
          enabledChainIds?: string[];
        };
        const account = await importWallet(payload);
        return { ok: true, data: { account } };
      }

      case "UNLOCK": {
        const payload = message.payload as { password: string };
        const accounts = await unlockWallet(payload.password);
        return { ok: true, data: { accounts } };
      }

      case "LOCK":
        await lockWallet();
        return { ok: true };

      case "GET_ACCOUNTS":
        return { ok: true, data: await getAccounts() };

      case "GET_CHAIN_ACCOUNTS": {
        const payload = message.payload as { chainIds?: string[] } | undefined;
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        return { ok: true, data: await getChainAccounts(chainIds) };
      }

      case "GET_ENABLED_CHAINS":
        return { ok: true, data: await getEnabledChainIds() };

      case "SET_ENABLED_CHAINS": {
        const payload = message.payload as { chainIds: string[] };
        return { ok: true, data: await setEnabledChainIds(payload.chainIds) };
      }

      case "LIST_CUSTOM_CHAINS":
        return { ok: true, data: await listCustomChains() };

      case "SAVE_CUSTOM_CHAIN": {
        const payload = message.payload as { draft: CustomChainDraft };
        return { ok: true, data: await saveCustomChain(payload.draft) };
      }

      case "REMOVE_CUSTOM_CHAIN": {
        const payload = message.payload as { chainId: string };
        const rows = await removeCustomChain(payload.chainId);
        const enabled = await getEnabledChainIds();
        if (enabled.includes(payload.chainId)) {
          await setEnabledChainIds(
            enabled.filter((id) => id !== payload.chainId),
          );
        }
        return { ok: true, data: rows };
      }

      case "REVEAL_MNEMONIC": {
        const payload = message.payload as { password: string };
        const mnemonic = await revealMnemonic(payload.password);
        return { ok: true, data: { mnemonic } };
      }

      case "RESET_WALLET": {
        const payload = message.payload as
          | { password?: string }
          | undefined;
        await resetWallet(payload?.password);
        return { ok: true };
      }

      case "SET_ACTIVE_ACCOUNT": {
        const payload = message.payload as { index: number };
        await setActiveAccount(payload.index);
        return { ok: true };
      }

      case "ADD_ACCOUNT": {
        const payload = message.payload as { name?: string } | undefined;
        return { ok: true, data: await addAccount(payload?.name) };
      }

      case "RENAME_ACCOUNT": {
        const payload = message.payload as { index: number; name: string };
        return {
          ok: true,
          data: await renameAccount(payload.index, payload.name),
        };
      }

      case "GET_BALANCES": {
        const payload = message.payload as
          | { chainIds?: string[]; force?: boolean }
          | undefined;
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const accounts = await getChainAccounts(chainIds);
        return {
          ok: true,
          data: await getChainBalances(accounts, { force: payload?.force }),
        };
      }

      case "GET_PRICES": {
        const payload = message.payload as
          | { chainIds?: string[]; force?: boolean }
          | undefined;
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        return {
          ok: true,
          data: await getPrices(chainIds, { force: payload?.force }),
        };
      }

      case "GET_VALIDATORS": {
        const payload = message.payload as { chainId: string };
        return { ok: true, data: await fetchValidators(payload.chainId) };
      }

      case "GET_DELEGATIONS": {
        const payload = message.payload as { chainIds?: string[] };
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const accounts = await getChainAccounts(chainIds);
        const rows = await Promise.all(
          accounts.map((a) =>
            fetchDelegations(a.chainId, a.address).catch(() => []),
          ),
        );
        return { ok: true, data: rows.flat() };
      }

      case "GET_UNBONDING": {
        const payload = message.payload as { chainIds?: string[] };
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const accounts = await getChainAccounts(chainIds);
        const rows = await Promise.all(
          accounts.map((a) =>
            fetchUnbonding(a.chainId, a.address).catch(() => []),
          ),
        );
        return { ok: true, data: rows.flat() };
      }

      case "GET_PROPOSALS": {
        const payload = message.payload as { chainIds?: string[] };
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const rows = await Promise.all(
          chainIds.map((chainId) => fetchProposals(chainId).catch(() => [])),
        );
        return { ok: true, data: rows.flat() };
      }

      case "GET_ACTIVITY": {
        const payload = message.payload as { chainIds?: string[] };
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const accounts = await getChainAccounts(chainIds);
        const rows = await Promise.all(
          accounts.map((a) =>
            fetchActivity(a.chainId, a.address).catch(() => []),
          ),
        );
        return { ok: true, data: rows.flat().sort((a, b) => b.timestamp - a.timestamp) };
      }

      case "FIND_IBC_CHANNELS": {
        const payload = message.payload as {
          sourceChainId: string;
          destChainId: string;
        };
        return {
          ok: true,
          data: await findIbcChannels(
            payload.sourceChainId,
            payload.destChainId,
          ),
        };
      }

      case "VALIDATE_IBC_CHANNEL": {
        const payload = message.payload as {
          sourceChainId: string;
          channelId: string;
          destChainId?: string;
        };
        return {
          ok: true,
          data: await validateIbcChannel(
            payload.sourceChainId,
            payload.channelId,
            payload.destChainId,
          ),
        };
      }

      case "LIST_ADDRESS_BOOK":
        return { ok: true, data: await listAddressBook() };

      case "SAVE_ADDRESS_BOOK_ENTRY": {
        const payload = message.payload as {
          label: string;
          address: string;
          chainId?: string;
        };
        return { ok: true, data: await saveAddressBookEntry(payload) };
      }

      case "REMOVE_ADDRESS_BOOK_ENTRY": {
        const payload = message.payload as { id: string };
        return { ok: true, data: await removeAddressBookEntry(payload.id) };
      }

      case "LIST_PERMISSIONS":
        return { ok: true, data: await listActiveGrants() };

      case "REVOKE_PERMISSION": {
        const payload = message.payload as { origin: string };
        await revokePermission(payload.origin);
        return { ok: true };
      }

      case "GET_SETTINGS":
        return { ok: true, data: await getSettings() };

      case "SET_SETTINGS": {
        const payload = message.payload as Parameters<typeof setSettings>[0];
        if (payload.liveBalances === false) {
          await Promise.all([clearBalanceCache(), clearPriceCache()]);
        }
        // Prices are quoted in the display currency, so a switch invalidates.
        if (payload.currency) await clearPriceCache();
        return { ok: true, data: await setSettings(payload) };
      }

      case "GET_PENDING_APPROVALS":
        return { ok: true, data: getPendingApprovals() };

      case "RESOLVE_APPROVAL": {
        const payload = message.payload as { id: string; result?: unknown };
        const ok = resolveApproval(payload.id, payload.result ?? { approved: true });
        return ok
          ? { ok: true }
          : { ok: false, error: "Approval not found" };
      }

      case "REJECT_APPROVAL": {
        const payload = message.payload as { id: string; reason?: string };
        const ok = rejectApproval(payload.id, payload.reason);
        return ok
          ? { ok: true }
          : { ok: false, error: "Approval not found" };
      }

      case "PROVIDER_REQUEST": {
        const payload = message.payload as {
          method: ProviderMethod;
          args: unknown[];
        };
        const origin =
          message.origin ??
          sender.origin ??
          (sender.url ? new URL(sender.url).origin : "");
        if (!origin) return { ok: false, error: "Missing origin" };
        const data = await handleProviderRequest({
          origin,
          method: payload.method,
          args: payload.args ?? [],
          tabId: sender.tab?.id,
        });
        return { ok: true, data };
      }

      case "TOUCH_SESSION":
        await touchSession();
        return { ok: true };

      default:
        return { ok: false, error: `Unknown message: ${(message as ExtensionMessage).type}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export default defineBackground(() => {
  registerSessionLifecycle();
  void hydrateCustomChains();

  // A fresh install lands on the full-tab flow: a 24 word phrase does not fit
  // in a 360px popup without scrolling, which is where people mistranscribe.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    void getStatus().then((status) => {
      if (status.hasWallet) return;
      void browser.tabs.create({
        url: browser.runtime.getURL("/onboarding.html"),
      });
    });
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void routeMessage(message as ExtensionMessage, sender).then(sendResponse);
    return true;
  });

  browser.runtime.onMessageExternal?.addListener(
    (message, sender, sendResponse) => {
      void routeMessage(message as ExtensionMessage, sender).then(sendResponse);
      return true;
    },
  );

  console.info("[zunia] background ready");
});
