import {
  SIGNING_KINDS,
  getApproval,
  getPendingApprovals,
  onApprovalsChanged,
  rejectApproval,
  rejectApprovalsWhere,
  resolveApproval,
} from "../lib/approvals";
import {
  APPROVAL_UI_PORT,
  onApprovalUiClosed,
  registerApprovalUiPort,
} from "../lib/approval-ui";
import { getAccountAddresses } from "../lib/account-addresses";
import { approvalIdFromPortName } from "../lib/connect-overlay";
import {
  isExternallyConnectableOrigin,
  type ExtensionMessage,
  type ExtensionResponse,
} from "../lib/messaging";
import {
  listActiveGrants,
  revokeAllPermissions,
  revokeChain,
  revokePermission,
} from "../lib/permissions";
import {
  cancelUnlockWait,
  handleProviderRequest,
  type ProviderMethod,
} from "../lib/provider-handler";
import {
  classifySender,
  messageAllowed,
  providerOriginFromSender,
  type SenderKind,
} from "../lib/sender-policy";
import {
  addAccount,
  createWallet,
  generateMnemonicPhrase,
  getAccounts,
  getChainAccounts,
  getPasswordThrottle,
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
  verifyPassword,
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
import { signAndBroadcast } from "../lib/wallet-tx";
import type { AminoMsg, StdFee } from "../lib/amino-tx";
import {
  fetchActivity,
  fetchTxDetail,
  fetchDelegations,
  fetchProposals,
  fetchUnbonding,
  fetchValidators,
} from "../lib/chain-queries";
import {
  channelService,
  clearInterchainCaches,
} from "../lib/interchain";
import {
  previewTx,
  signAndBroadcastTx,
  txKernelStatus,
  type TxRequest,
  type TxSignRequest,
} from "../lib/tx-kernel";
import {
  listAddressBook,
  removeAddressBookEntry,
  saveAddressBookEntry,
  toggleAddressBookFavorite,
  touchAddressBookEntry,
  updateAddressBookEntry,
  type ContactPatch,
} from "../lib/address-book";
import { getSettings, setSettings } from "../lib/settings";
import { STORAGE_KEYS } from "../lib/storage-keys";
import {
  TRANSFER_WATCH_ALARM,
  runTransferWatch,
  syncTransferWatch,
} from "../lib/transfer-watch";

interface Sender {
  id?: string;
  origin?: string;
  url?: string;
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
}

/**
 * The connect frame each pending in-page prompt is bound to. The first frame to
 * open a port for an approval owns it; that frame, and only that frame, may
 * answer it.
 */
interface OverlayBinding {
  tabId: number;
  frameId?: number;
  documentId?: string;
}
const overlayBindings = new Map<string, OverlayBinding>();

function frameOwnsApproval(sender: Sender, approvalId: string): boolean {
  const binding = overlayBindings.get(approvalId);
  if (!binding || sender.tab?.id !== binding.tabId) return false;
  if (binding.frameId !== undefined && sender.frameId !== binding.frameId) return false;
  if (binding.documentId && sender.documentId && sender.documentId !== binding.documentId) {
    return false;
  }
  const approval = getApproval(approvalId);
  return approval?.kind === "enable";
}

/** The connect frame may only act while it owns a live connection request. */
function frameOwnsAnyApproval(sender: Sender): boolean {
  for (const id of overlayBindings.keys()) {
    if (frameOwnsApproval(sender, id)) return true;
  }
  return false;
}

/** Same, allowing for a first read that lands just before the frame's port. */
async function connectFrameBound(sender: Sender): Promise<boolean> {
  for (let waited = 0; ; waited += 50) {
    if (frameOwnsAnyApproval(sender)) return true;
    if (waited >= 500) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A string field from a popup payload; anything else reads as empty. */
function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function requireSigningPassword(password: unknown): Promise<void> {
  const settings = await getSettings();
  if (!settings.requirePasswordOnSign) return;
  await verifyPassword(typeof password === "string" ? password : "");
}

/**
 * Tell pages about a wallet change. `origins` narrows delivery to those sites;
 * without it every page with the provider hears it, carrying no data, which is
 * how Keplr's `keplr_keystorechange` behaves.
 */
async function broadcastProviderEvent(
  event: string,
  origins?: string[],
  data?: { chainIds: string[] },
): Promise<void> {
  let tabs: Array<{ id?: number }> = [];
  try {
    tabs = await browser.tabs.query({});
  } catch {
    return;
  }
  const message = { type: "PROVIDER_EVENT", payload: { event, origins, data } };
  await Promise.all(
    tabs.map((tab) =>
      typeof tab.id === "number"
        ? browser.tabs.sendMessage(tab.id, message).catch(() => undefined)
        : undefined,
    ),
  );
}

async function routeMessage(
  message: ExtensionMessage,
  sender: Sender,
  external: boolean,
): Promise<ExtensionResponse> {
  try {
    const kind: SenderKind = classifySender(sender, {
      extensionId: browser.runtime.id,
      extensionBaseUrl: browser.runtime.getURL("/" as never),
      external,
    });

    if (kind === "external") {
      if (!sender.origin || !isExternallyConnectableOrigin(sender.origin)) {
        return { ok: false, error: "Origin not allowed" };
      }
    }
    if (!messageAllowed(kind, message.type)) {
      return { ok: false, error: "Method not allowed for this sender" };
    }
    // A connect frame that owns no live request (a page loading the frame URL
    // itself, or a prompt already answered) gets no account data.
    const frameBound = kind === "connect-frame" ? await connectFrameBound(sender) : true;

    switch (message.type) {
      case "PING":
        return { ok: true, data: { pong: true } };

      case "GET_STATUS": {
        const status = await getStatus();
        // A website may learn that Zunia is installed and whether it is set up,
        // never the accounts inside it.
        if (kind === "external" || !frameBound) {
          return {
            ok: true,
            data: { hasWallet: status.hasWallet, unlocked: status.unlocked },
          };
        }
        return { ok: true, data: status };
      }

      case "GET_PASSWORD_THROTTLE":
        return { ok: true, data: await getPasswordThrottle() };

      case "GET_ACCOUNT_ADDRESSES": {
        if (!frameBound) {
          return { ok: false, error: "No connection request is open in this frame" };
        }
        const payload = message.payload as { chainId?: string } | undefined;
        if (!payload?.chainId) return { ok: false, error: "chainId required" };
        return { ok: true, data: await getAccountAddresses(payload.chainId) };
      }

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
        if (!frameBound) {
          return { ok: false, error: "No connection request is open in this frame" };
        }
        const payload = message.payload as { index: number };
        await setActiveAccount(payload.index);
        void broadcastProviderEvent("accountsChanged");
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

      case "GET_ACTIVITY_FEED": {
        const payload = message.payload as { chainIds?: string[]; limit?: number };
        const chainIds = payload?.chainIds ?? (await getEnabledChainIds());
        const accounts = await getChainAccounts(chainIds);
        const results = await Promise.all(
          accounts.map((a) =>
            fetchActivity(a.chainId, a.address, payload?.limit).then(
              (rows) => ({ chainId: a.chainId, rows, failed: false }),
              () => ({ chainId: a.chainId, rows: [], failed: true }),
            ),
          ),
        );
        return {
          ok: true,
          data: {
            rows: results.flatMap((r) => r.rows).sort((a, b) => b.timestamp - a.timestamp),
            failed: results.filter((r) => r.failed).map((r) => r.chainId),
          },
        };
      }

      case "GET_TX_DETAIL": {
        const payload = message.payload as { chainId: string; hash: string };
        const [account] = await getChainAccounts([payload.chainId]);
        return {
          ok: true,
          data: await fetchTxDetail(payload.chainId, payload.hash, account?.address ?? ""),
        };
      }

      // Channel discovery and validation are the interchain engine's, not this
      // worker's: the hand-rolled copy that used to live in lib/ibc-channels.ts
      // was deleted when @zunialab/interchain took over. The popup calls the
      // engine directly for route planning; these two messages stay because the
      // engine's caches live in whichever context asks, and a background answer
      // survives a popup close.
      case "FIND_IBC_CHANNELS": {
        const payload = message.payload as {
          sourceChainId: string;
          destChainId: string;
        };
        return {
          ok: true,
          data: await channelService().findIbcChannels(
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
          data: await channelService().validateIbcChannel(
            payload.sourceChainId,
            payload.channelId,
            payload.destChainId,
            { checkCounterparty: true },
          ),
        };
      }

      case "LIST_ADDRESS_BOOK":
        return { ok: true, data: await listAddressBook() };

      case "SAVE_ADDRESS_BOOK_ENTRY": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        return {
          ok: true,
          data: await saveAddressBookEntry({
            label: textField(payload.label),
            address: textField(payload.address),
            ...(typeof payload.chainId === "string" ? { chainId: payload.chainId } : {}),
            ...(typeof payload.note === "string" ? { note: payload.note } : {}),
            favorite: payload.favorite === true,
          }),
        };
      }

      case "UPDATE_ADDRESS_BOOK_ENTRY": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        const patch: ContactPatch = {
          ...(typeof payload.label === "string" ? { label: payload.label } : {}),
          ...(typeof payload.address === "string" ? { address: payload.address } : {}),
          ...(typeof payload.chainId === "string" || payload.chainId === null
            ? { chainId: payload.chainId }
            : {}),
          ...(typeof payload.note === "string" || payload.note === null
            ? { note: payload.note }
            : {}),
        };
        return {
          ok: true,
          data: await updateAddressBookEntry(textField(payload.id), patch),
        };
      }

      case "REMOVE_ADDRESS_BOOK_ENTRY": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        return { ok: true, data: await removeAddressBookEntry(textField(payload.id)) };
      }

      case "TOGGLE_ADDRESS_BOOK_FAVORITE": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        return { ok: true, data: await toggleAddressBookFavorite(textField(payload.id)) };
      }

      case "TOUCH_ADDRESS_BOOK_ENTRY": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        return { ok: true, data: await touchAddressBookEntry(textField(payload.address)) };
      }

      case "LIST_PERMISSIONS":
        return { ok: true, data: await listActiveGrants() };

      case "REVOKE_PERMISSION": {
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        const origin = textField(payload.origin);
        if (!origin) return { ok: false, error: "origin required" };
        const chainId = textField(payload.chainId);
        // Either way the page hears it: a site that keeps other chains is
        // told which ones it lost.
        if (chainId) {
          await revokeChain(origin, chainId);
          void broadcastProviderEvent("disconnect", [origin], { chainIds: [chainId] });
        } else {
          await revokePermission(origin);
          void broadcastProviderEvent("disconnect", [origin]);
        }
        return { ok: true };
      }

      case "REVOKE_ALL_PERMISSIONS": {
        const origins = await revokeAllPermissions();
        if (origins.length > 0) void broadcastProviderEvent("disconnect", origins);
        return { ok: true, data: { revoked: origins.length } };
      }

      case "GET_SETTINGS":
        return { ok: true, data: await getSettings() };

      case "SET_SETTINGS": {
        const payload = message.payload as Parameters<typeof setSettings>[0];
        if (payload.liveBalances === false) {
          await Promise.all([clearBalanceCache(), clearPriceCache()]);
        }
        // The engine caches LCD bodies and the answer to "may we read?" for a
        // second; flipping the switch either way must invalidate both, or the
        // next read is decided by the old setting.
        if (payload.liveBalances !== undefined) clearInterchainCaches();
        // Prices are quoted in the display currency, so a switch invalidates.
        if (payload.currency) await clearPriceCache();
        return { ok: true, data: await setSettings(payload) };
      }

      case "GET_PENDING_APPROVALS": {
        const pending = getPendingApprovals();
        // The in-page frame sees the one request it is bound to, nothing else.
        // An empty list is also how it learns the request was answered elsewhere.
        if (kind === "connect-frame") {
          return {
            ok: true,
            data: pending.filter((item) => frameOwnsApproval(sender, item.id)),
          };
        }
        return { ok: true, data: pending };
      }

      case "RESOLVE_APPROVAL": {
        const payload = message.payload as {
          id: string;
          result?: unknown;
          password?: string;
        };
        const approval = getApproval(payload.id);
        if (!approval) return { ok: false, error: "Approval not found" };
        if (kind === "connect-frame" && !frameOwnsApproval(sender, payload.id)) {
          return { ok: false, error: "This frame cannot answer that request" };
        }
        const result = payload.result ?? { approved: true };
        const approving = (result as { approved?: boolean }).approved === true;
        if (approving && SIGNING_KINDS.has(approval.kind)) {
          await requireSigningPassword(payload.password);
        }
        const ok = resolveApproval(payload.id, result);
        return ok
          ? { ok: true }
          : { ok: false, error: "Approval not found" };
      }

      case "REJECT_APPROVAL": {
        const payload = message.payload as { id: string; reason?: string };
        if (kind === "connect-frame" && !frameOwnsApproval(sender, payload.id)) {
          return { ok: false, error: "This frame cannot answer that request" };
        }
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
        const origin = providerOriginFromSender(sender);
        if (!origin) return { ok: false, error: "Missing origin" };
        // The content script also names the origin. If it disagrees with the
        // browser, something is impersonating it.
        if (message.origin && message.origin !== origin) {
          return { ok: false, error: "Origin mismatch" };
        }
        const data = await handleProviderRequest({
          origin,
          method: payload.method,
          args: Array.isArray(payload.args) ? payload.args : [],
          tabId: sender.tab?.id,
        });
        return { ok: true, data };
      }

      case "TOUCH_SESSION":
        await touchSession();
        return { ok: true };

      case "SIGN_AND_BROADCAST": {
        const payload = message.payload as {
          chainId: string;
          signerAddress: string;
          msgs: AminoMsg[];
          memo?: string;
          gasLimit?: number;
          fee?: StdFee;
        };
        if (!payload?.chainId || !payload.signerAddress || !payload.msgs?.length) {
          return { ok: false, error: "chainId, signerAddress, and msgs required" };
        }
        await requireSigningPassword((message.payload as { password?: string }).password);
        const data = await signAndBroadcast(payload);
        return { ok: true, data };
      }

      case "KERNEL_STATUS":
        return { ok: true, data: await txKernelStatus() };

      case "BUILD_TX_PREVIEW": {
        const payload = message.payload as TxRequest;
        if (!payload?.chainId || !payload.signerAddress || !payload.msgs?.length) {
          return { ok: false, error: "chainId, signerAddress, and msgs required" };
        }
        return { ok: true, data: await previewTx(payload) };
      }

      case "SIGN_AND_BROADCAST_TX": {
        const payload = message.payload as TxSignRequest;
        if (!payload?.chainId || !payload.signerAddress || !payload.msgs?.length) {
          return { ok: false, error: "chainId, signerAddress, and msgs required" };
        }
        if (!payload.expectSignBytesHash) {
          // Without the hash there is nothing tying the signature to what the
          // user approved, so this is refused rather than defaulted.
          return { ok: false, error: "expectSignBytesHash is required" };
        }
        await requireSigningPassword((message.payload as { password?: string }).password);
        return { ok: true, data: await signAndBroadcastTx(payload) };
      }

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

function onPortConnect(port: ReturnType<typeof browser.runtime.connect>): void {
  const sender = (port.sender ?? {}) as Sender;
  const kind = classifySender(sender, {
    extensionId: browser.runtime.id,
    extensionBaseUrl: browser.runtime.getURL("/" as never),
    external: false,
  });

  if (port.name === APPROVAL_UI_PORT) {
    if (kind !== "extension-page") {
      port.disconnect();
      return;
    }
    registerApprovalUiPort(port);
    return;
  }

  const approvalId = approvalIdFromPortName(port.name);
  if (approvalId === null) return;
  const approval = getApproval(approvalId);
  const tabId = sender.tab?.id;
  if (
    kind !== "connect-frame" ||
    !approval ||
    approval.kind !== "enable" ||
    typeof tabId !== "number" ||
    approval.tabId !== tabId
  ) {
    port.disconnect();
    return;
  }
  if (overlayBindings.has(approvalId)) {
    // A second frame claiming the same prompt is a page replaying the frame URL
    // to put a copy of the prompt somewhere it controls. Cancel the request.
    port.disconnect();
    rejectApproval(approvalId, "The connection prompt was opened twice, so Zunia cancelled it");
    return;
  }
  overlayBindings.set(approvalId, {
    tabId,
    frameId: sender.frameId,
    documentId: sender.documentId,
  });
  port.onDisconnect.addListener(() => {
    overlayBindings.delete(approvalId);
    // The frame going away means nobody can answer any more: tab closed, page
    // navigated, overlay removed. No-op if it was already answered.
    rejectApproval(approvalId, "Connection prompt closed");
  });
}

function updateBadge(count: number): void {
  const action = browser.action;
  if (!action?.setBadgeText) return;
  void action.setBadgeText({ text: count > 0 ? String(count) : "" }).catch(() => undefined);
  // --z-accent from @zunialab/tokens; the badge API takes a literal color.
  void action.setBadgeBackgroundColor?.({ color: "#ff1b0c" }).catch(() => undefined);
}

export default defineBackground(() => {
  registerSessionLifecycle();
  void hydrateCustomChains();

  browser.runtime.onConnect.addListener(onPortConnect);

  onApprovalsChanged((pending) => {
    updateBadge(pending.length);
    // Open extension pages refresh their queue; nobody listening is fine.
    void browser.runtime
      .sendMessage({ type: "APPROVALS_CHANGED" })
      .catch(() => undefined);
  });

  onApprovalUiClosed(() => {
    // Only requests shown in the popup. A connection request whose in-page
    // prompt is still mounting has no host yet and must survive this.
    rejectApprovalsWhere(
      (item) => item.host === "popup",
      "The Zunia window was closed before the request was answered",
    );
    cancelUnlockWait("The Zunia window was closed before unlocking");
  });

  // Every lock path (button, auto-lock alarm, idle, screen lock) and every
  // unlock ends up here, so pages hear about all of them exactly once. Locking
  // sends its own event rather than accountsChanged: a Keplr dApp re-reads the
  // key on keystorechange, and while locked that would open the unlock window
  // once per connected site.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;
    const change = changes[STORAGE_KEYS.sessionMnemonic];
    if (!change) return;
    const wasOpen = typeof change.oldValue === "string";
    const isOpen = typeof change.newValue === "string";
    if (wasOpen && !isOpen) void broadcastProviderEvent("locked");
    else if (!wasOpen && isOpen) void broadcastProviderEvent("accountsChanged");
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    rejectApprovalsWhere((item) => item.tabId === tabId, "The requesting tab was closed");
  });

  // Routes signed in the popup keep being followed after it closes.
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === TRANSFER_WATCH_ALARM) void runTransferWatch().catch(() => undefined);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEYS.pendingTransfers]) return;
    void syncTransferWatch().catch(() => undefined);
  });
  void syncTransferWatch().catch(() => undefined);

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
    void routeMessage(message as ExtensionMessage, sender as Sender, false).then(
      sendResponse,
    );
    return true;
  });

  browser.runtime.onMessageExternal?.addListener(
    (message, sender, sendResponse) => {
      void routeMessage(message as ExtensionMessage, sender as Sender, true).then(
        sendResponse,
      );
      return true;
    },
  );

  console.info("[zunia] background ready");
});
