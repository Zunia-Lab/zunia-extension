import {
  enqueueApproval,
  enqueueApprovalWithId,
  getPendingApprovals,
} from "./approvals";
import { BUILTIN_CHAINS, chainJsonFor, getBuiltinChain, type ChainInfo } from "./chains";
import { loadKernel } from "./kernel";
import {
  grantPermission,
  hasPermission,
} from "./permissions";
import {
  getAccounts,
  getActiveAccountIndex,
  getSessionMnemonic,
  isUnlocked,
  touchSession,
} from "./session";
import { getSettings } from "./settings";
import type { ExtensionResponse } from "./messaging";
import { decodeSignDoc, rememberRecipient } from "./signing";
import { STORAGE_KEYS } from "./storage-keys";

export type ProviderMethod =
  | "enable"
  | "getKey"
  | "getAccounts"
  | "signAmino"
  | "signDirect"
  | "sendTx"
  | "experimentalSuggestChain"
  | "getChainInfos"
  | "getChainInfosWithoutEndpoints";

async function openApprovalUi(): Promise<void> {
  try {
    if (browser.action?.openPopup) {
      await browser.action.openPopup();
      return;
    }
  } catch {
    // Fall through to window.
  }
  const url = browser.runtime.getURL("popup.html" as never);
  await browser.windows.create({
    url: `${url}?approve=1`,
    type: "popup",
    width: 360,
    height: 600,
  });
}

/**
 * Asks the tab that made the request to draw the connect modal over the page.
 *
 * Resolves false when there is no content script to talk to (the tab was
 * closed, or the page is one the script never ran on), so the caller can fall
 * back to the toolbar popup rather than leaving the dApp waiting on a modal
 * that was never mounted.
 */
async function showConnectOverlay(
  tabId: number | undefined,
  approvalId: string,
): Promise<boolean> {
  if (typeof tabId !== "number") return false;
  try {
    const response = (await browser.tabs.sendMessage(tabId, {
      type: "SHOW_CONNECT_OVERLAY",
      payload: { approvalId },
    })) as ExtensionResponse | undefined;
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function requireUnlocked(): Promise<string> {
  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");
  await touchSession();
  return mnemonic;
}

async function loadSuggestedChains(): Promise<ChainInfo[]> {
  const result = await browser.storage.local.get(STORAGE_KEYS.suggestedChains);
  return (
    (result[STORAGE_KEYS.suggestedChains] as ChainInfo[] | undefined) ?? []
  );
}

async function allChains(): Promise<ChainInfo[]> {
  const suggested = await loadSuggestedChains();
  const map = new Map<string, ChainInfo>();
  for (const c of [...BUILTIN_CHAINS, ...suggested]) {
    map.set(c.chainId, c);
  }
  return [...map.values()];
}

function normalizeChainIds(chainIds: string | string[]): string[] {
  return (Array.isArray(chainIds) ? chainIds : [chainIds]).filter(Boolean);
}

export async function handleProviderRequest(input: {
  origin: string;
  method: ProviderMethod;
  args: unknown[];
  /** Tab the request came from, when it came through a content script. */
  tabId?: number;
}): Promise<unknown> {
  const { origin, method, args, tabId } = input;

  switch (method) {
    case "enable": {
      const chainIds = normalizeChainIds(args[0] as string | string[]);
      if (chainIds.length === 0) throw new Error("chainId required");
      if (!(await isUnlocked())) throw new Error("Wallet is locked");
      if (await hasPermission(origin, chainIds)) return null;

      const { id, result } = enqueueApprovalWithId({
        kind: "enable",
        origin,
        chainIds,
        title: `Connect to ${origin}`,
        detail: { chainIds },
      });

      // Connection prompts render over the page so the choice stays next to
      // the site asking for it. Signing never does: those keep to the popup,
      // which a page cannot draw over or spoof.
      void showConnectOverlay(tabId, id).then((mounted) => {
        if (mounted) return;
        void openApprovalUi();
      });

      const approved = (await result) as { approved: boolean };
      if (!approved?.approved) throw new Error("Request rejected");
      await grantPermission(origin, chainIds);
      return null;
    }

    case "getKey": {
      const chainId = String(args[0] ?? "");
      if (!chainId) throw new Error("chainId required");
      if (!(await hasPermission(origin, [chainId]))) {
        throw new Error("Not authorized");
      }
      const mnemonic = await requireUnlocked();
      const accounts = await getAccounts();
      const active = await getActiveAccountIndex();
      const account = accounts.find((a) => a.index === active) ?? accounts[0];
      if (!account) throw new Error("No account");
      const kernel = await loadKernel();
      const derived = kernel.deriveAddress(
        mnemonic,
        "",
        chainJsonFor(chainId),
        account.index,
      );
      return {
        name: account.name,
        algo: derived.algo,
        pubKey: Array.from(derived.pubKey),
        address: derived.address,
        bech32Address: derived.bech32Address,
        isNanoLedger: false,
      };
    }

    case "getAccounts": {
      const chainId = String(args[0] ?? args[0] ?? "");
      // Keplr-style offline signer uses chain from getOfflineSigner; here we accept optional chainId.
      const accounts = await getAccounts();
      if (!(await isUnlocked())) throw new Error("Wallet is locked");
      if (chainId && !(await hasPermission(origin, [chainId]))) {
        throw new Error("Not authorized");
      }
      const mnemonic = await requireUnlocked();
      const kernel = await loadKernel();
      const active = await getActiveAccountIndex();
      const account = accounts.find((a) => a.index === active) ?? accounts[0];
      if (!account) return [];
      const derived = kernel.deriveAddress(
        mnemonic,
        "",
        chainJsonFor(chainId || "cosmoshub-4"),
        account.index,
      );
      return [
        {
          address: derived.bech32Address,
          algo: derived.algo,
          pubkey: Array.from(derived.pubKey),
        },
      ];
    }

    case "signAmino": {
      const chainId = String(args[0] ?? "");
      const signer = String(args[1] ?? "");
      const signDoc = args[2];
      if (!(await hasPermission(origin, [chainId]))) {
        throw new Error("Not authorized");
      }
      const mnemonic = await requireUnlocked();
      const summary = await decodeSignDoc(chainId, signDoc);
      if (summary.requiresBlindSigning) {
        throw new Error("Blind signing disabled for unknown messages");
      }
      const approval = enqueueApproval({
        kind: "signAmino",
        origin,
        chainIds: [chainId],
        title: `Sign transaction on ${chainId}`,
        detail: { signer, signDoc, summary },
        warnings: summary.warnings,
      });
      void openApprovalUi();
      const approved = (await approval) as { approved: boolean };
      if (!approved?.approved) throw new Error("Request rejected");

      for (const msg of summary.messages) {
        const recipient = (signDoc as { msgs?: Array<{ value?: { to_address?: string } }> })
          ?.msgs?.[0]?.value?.to_address;
        if (recipient) await rememberRecipient(recipient);
      }

      const kernel = await loadKernel();
      const active = await getActiveAccountIndex();
      const signature = kernel.signCosmos(
        mnemonic,
        "",
        chainJsonFor(chainId),
        active,
        JSON.stringify(signDoc),
      );
      const accounts = await getAccounts();
      const account = accounts.find((a) => a.index === active) ?? accounts[0]!;
      return {
        signed: signDoc,
        signature: {
          pub_key: {
            type: "tendermint/PubKeySecp256k1",
            value: account.pubKeyHex ?? "",
          },
          signature,
        },
      };
    }

    case "signDirect": {
      const chainId = String(args[0] ?? "");
      const signer = String(args[1] ?? "");
      const signDoc = args[2];
      if (!(await hasPermission(origin, [chainId]))) {
        throw new Error("Not authorized");
      }
      const mnemonic = await requireUnlocked();
      const summary = await decodeSignDoc(chainId, signDoc);
      if (summary.requiresBlindSigning) {
        throw new Error("Blind signing disabled for unknown messages");
      }
      const approval = enqueueApproval({
        kind: "signDirect",
        origin,
        chainIds: [chainId],
        title: `Sign direct on ${chainId}`,
        detail: { signer, signDoc, summary },
        warnings: summary.warnings,
      });
      void openApprovalUi();
      const approved = (await approval) as { approved: boolean };
      if (!approved?.approved) throw new Error("Request rejected");

      const kernel = await loadKernel();
      const active = await getActiveAccountIndex();
      const signature = kernel.signCosmos(
        mnemonic,
        "",
        chainJsonFor(chainId),
        active,
        typeof signDoc === "string" ? signDoc : JSON.stringify(signDoc),
      );
      return {
        signed: signDoc,
        signature: {
          pub_key: {
            type: "tendermint/PubKeySecp256k1",
            value: "",
          },
          signature,
        },
      };
    }

    case "sendTx": {
      const chainId = String(args[0] ?? "");
      const tx = args[1];
      const mode = args[2] ?? "sync";
      if (!(await hasPermission(origin, [chainId]))) {
        throw new Error("Not authorized");
      }
      await requireUnlocked();
      const approval = enqueueApproval({
        kind: "sendTx",
        origin,
        chainIds: [chainId],
        title: `Broadcast transaction on ${chainId}`,
        detail: { mode, txPreview: typeof tx === "string" ? tx.slice(0, 64) : tx },
        warnings: [
          "Broadcast uses the dApp or user-granted RPC; the extension does not hold broad host permissions.",
        ],
      });
      void openApprovalUi();
      const approved = (await approval) as { approved: boolean; txHash?: string };
      if (!approved?.approved) throw new Error("Request rejected");
      // Placeholder: real broadcast needs CosmJS + user RPC. Return mock hash.
      return (
        approved.txHash ??
        `MOCK${Date.now().toString(16).toUpperCase()}`
      );
    }

    case "experimentalSuggestChain": {
      const chainInfo = args[0] as ChainInfo;
      if (!chainInfo?.chainId) throw new Error("Invalid chain info");
      const approval = enqueueApproval({
        kind: "suggestChain",
        origin,
        chainIds: [chainInfo.chainId],
        title: `Add chain ${chainInfo.chainName ?? chainInfo.chainId}`,
        detail: { chainInfo },
      });
      void openApprovalUi();
      const approved = (await approval) as { approved: boolean };
      if (!approved?.approved) throw new Error("Request rejected");
      const existing = await loadSuggestedChains();
      if (!existing.some((c) => c.chainId === chainInfo.chainId) && !getBuiltinChain(chainInfo.chainId)) {
        await browser.storage.local.set({
          [STORAGE_KEYS.suggestedChains]: [...existing, chainInfo],
        });
      }
      return null;
    }

    case "getChainInfos":
    case "getChainInfosWithoutEndpoints": {
      const chains = await allChains();
      if (method === "getChainInfosWithoutEndpoints") {
        return chains.map(({ rpc: _r, rest: _s, ...rest }) => rest);
      }
      return chains;
    }

    default:
      throw new Error(`Method not implemented: ${method}`);
  }
}

export async function providerStatusPayload(): Promise<{
  unlocked: boolean;
  exposeKeplrAlias: boolean;
  pendingApprovals: number;
}> {
  const settings = await getSettings();
  return {
    unlocked: await isUnlocked(),
    exposeKeplrAlias: settings.exposeKeplrAlias,
    pendingApprovals: getPendingApprovals().length,
  };
}
