import {
  enqueueApprovalWithId,
  extendApprovalChains,
  findPendingEnable,
  getPendingApprovals,
  setApprovalHost,
  type ApprovalRequest,
} from "./approvals";
import { approvalUiOpen, openApprovalUi } from "./approval-ui";
import { findCatalogEntry } from "./chain-catalog";
import { ChainDraftError, draftFromSuggestedChain } from "./chain-draft";
import { BUILTIN_CHAINS, chainJsonFor, toChainInfo, type ChainInfo } from "./chains";
import {
  hydrateCustomChains,
  listCustomChains,
  saveCustomChain,
} from "./custom-chains";
import {
  adr36PayloadIsSafe,
  adr36SignBytesHex,
  bytesToHex,
  ethereumHexAddress,
  fromBase64,
  hexToBytes,
  loadKernel,
  serializeAminoSignDoc,
  toBase64,
  verifyAdr36,
  type DerivedAddress,
} from "./kernel";
import {
  aminoFeeOf,
  authInfoFee,
  feeChoiceFor,
  isFeeTier,
  signOptionsFrom,
  withAminoFee,
  withAuthInfoFee,
  type FeeChoice,
  type FeeTier,
} from "./fee-tiers";
import { assessOrigin } from "./origin-risk";
import {
  connectedChains,
  grantPermission,
  hasPermission,
  revokeChain,
  revokePermission,
  touchPermission,
} from "./permissions";
import { ProviderError } from "./provider-errors";
import {
  ProviderGuardError,
  aminoSignDocChainId,
  assertSameChain,
  assertSigner,
  bytesFromWire,
  directSignDocToWire,
  encodeDirectSignDoc,
  normalizeDirectSignDoc,
} from "./provider-guards";
import {
  assertSignInBinding,
  looksLikeSignIn,
  parseSignInMessage,
  type SignInMessage,
} from "./sign-in";
import {
  getAccounts,
  derivationIndexOf,
  getActiveAccountIndex,
  getSessionMnemonic,
  isUnlocked,
  touchSession,
} from "./session";
import { getSettings } from "./settings";
import type { ExtensionResponse } from "./messaging";
import {
  decodeAminoSignDoc,
  decodeDirectSignBytes,
  rememberRecipient,
  type SignSafetySummary,
} from "./signing";
import { STORAGE_KEYS } from "./storage-keys";
import { SECURITY_CONFIG } from "../config/security";

export type ProviderMethod =
  | "enable"
  | "disable"
  | "getKey"
  | "getAccounts"
  | "signAmino"
  | "signDirect"
  | "signArbitrary"
  | "verifyArbitrary"
  | "sendTx"
  | "experimentalSuggestChain"
  | "getChainInfos"
  | "getChainInfosWithoutEndpoints"
  | "getConnectedChains"
  | "isLocked";

function invalidParams(message: string): ProviderError {
  return new ProviderError("INVALID_PARAMS", message);
}

function dataToBytes(data: unknown): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return bytesFromWire(data, "data");
}

/** The bytes as text when they are valid UTF-8, else null. */
function utf8Text(dataBytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(dataBytes);
  } catch {
    return null;
  }
}

function previewText(dataBytes: Uint8Array): string {
  const text = utf8Text(dataBytes);
  /* eslint-disable-next-line no-control-regex --
     Tab, LF and CR are deliberately inside the "this is human-readable text"
     class: an ADR-36 message may legitimately contain them. Anything else
     non-printable must fall through to the hex preview, which is exactly what
     matching against control characters here decides. */
  if (text !== null && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) {
    return text.length > 280 ? `${text.slice(0, 277)}…` : text;
  }
  const hex = bytesToHex(dataBytes);
  return hex.length > 96 ? `0x${hex.slice(0, 96)}…` : `0x${hex}`;
}

function wireBytesOf(raw: unknown, label: string): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  if (typeof raw !== "string") throw invalidParams(`Invalid ${label}`);
  const value = raw.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(value) && value.replace(/^0x/, "").length % 2 === 0) {
    return hexToBytes(value);
  }
  try {
    return fromBase64(value);
  } catch {
    throw invalidParams(`Invalid ${label}`);
  }
}

/**
 * The sign-in a message carries, checked against the request, or null for a
 * plain message. Anything that reads like a sign-in but does not pass is
 * refused here, before any window opens.
 */
function signInFor(
  dataBytes: Uint8Array,
  binding: { origin: string; chainId: string; signer: string },
): { message: SignInMessage; text: string } | null {
  if (!looksLikeSignIn(new TextDecoder().decode(dataBytes))) return null;
  const text = utf8Text(dataBytes);
  if (text === null) throw invalidParams("The sign-in message is not valid UTF-8");
  const message = parseSignInMessage(text);
  assertSignInBinding(message, binding);
  return { message, text };
}

/**
 * Asks the tab that made the request to draw the connect modal over the page.
 *
 * Resolves true only when the content script reports the prompt is actually on
 * screen. Anything else (no content script, a nested frame, a browser that
 * cannot prove the frame is visible, another prompt already up) sends the
 * request to the popup instead of leaving the dApp waiting on nothing.
 */
async function showConnectOverlay(
  tabId: number | undefined,
  approvalId: string,
  origin: string,
): Promise<boolean> {
  if (typeof tabId !== "number") return false;
  try {
    const response = (await browser.tabs.sendMessage(
      tabId,
      { type: "SHOW_CONNECT_OVERLAY", payload: { approvalId, origin } },
      { frameId: 0 },
    )) as ExtensionResponse | undefined;
    return (
      response?.ok === true &&
      (response.data as { shown?: unknown } | undefined)?.shown === true
    );
  } catch {
    return false;
  }
}

let unlockWait: Promise<void> | null = null;
let cancelUnlock: ((reason: string) => void) | null = null;

/** Rejects a request that is waiting for the user to unlock. */
export function cancelUnlockWait(reason: string): void {
  cancelUnlock?.(reason);
}

/**
 * Wait for the user to unlock, opening the popup to ask. Every request that
 * arrives while locked shares one wait, so a burst of calls opens one window.
 */
function waitForUnlock(): Promise<void> {
  if (unlockWait) return unlockWait;
  unlockWait = new Promise<void>((resolve, reject) => {
    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "session") return;
      if (typeof changes[STORAGE_KEYS.sessionMnemonic]?.newValue === "string") finish();
    };
    const timer = setTimeout(
      () => finish("Zunia stayed locked, so the request was cancelled"),
      SECURITY_CONFIG.approvals.ttlMs,
    );
    function finish(error?: string) {
      clearTimeout(timer);
      browser.storage.onChanged.removeListener(onChanged);
      unlockWait = null;
      cancelUnlock = null;
      if (error) reject(new ProviderError("LOCKED", error));
      else resolve();
    }
    cancelUnlock = finish;
    browser.storage.onChanged.addListener(onChanged);
    // The unlock may have landed between the caller's check and the listener.
    void isUnlocked().then((open) => {
      if (open) finish();
      else void openApprovalUi();
    });
  });
  return unlockWait;
}

async function unlockedMnemonic(): Promise<string> {
  let mnemonic = await getSessionMnemonic();
  if (!mnemonic) {
    await waitForUnlock();
    mnemonic = await getSessionMnemonic();
  }
  if (!mnemonic) throw new ProviderError("LOCKED", "Wallet is locked");
  await touchSession();
  return mnemonic;
}

let catalogReady: Promise<unknown> | null = null;

/** Custom chains are hydrated at boot, but a request can wake the worker first. */
async function ensureCatalog(): Promise<void> {
  catalogReady ??= hydrateCustomChains().catch(() => []);
  await catalogReady;
}

function requireChainId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalidParams("chainId required");
  return value;
}

async function requireKnownChain(chainId: string): Promise<void> {
  await ensureCatalog();
  if (!findCatalogEntry(chainId)) {
    throw new ProviderError(
      "UNKNOWN_CHAIN",
      `Zunia does not know the chain ${chainId}. Add it with experimentalSuggestChain first.`,
    );
  }
}

async function requirePermission(origin: string, chainId: string): Promise<void> {
  if (!(await hasPermission(origin, [chainId]))) {
    throw new ProviderError("NOT_CONNECTED", "Not authorized");
  }
}

interface ActiveKey {
  name: string;
  /** The account's row in the wallet; what "the active account changed" compares. */
  index: number;
  /**
   * The BIP-44 address index the key is derived at: the account index for an
   * account of the main phrase, 0 for an account with its own phrase. Every
   * signature is made at this index, or it does not match `derived.pubKey`.
   */
  derivationIndex: number;
  derived: DerivedAddress;
}

async function activeKey(mnemonic: string, chainId: string): Promise<ActiveKey> {
  const accounts = await getAccounts();
  const active = await getActiveAccountIndex();
  const account = accounts.find((a) => a.index === active) ?? accounts[0];
  if (!account) throw new Error("No account");
  const kernel = await loadKernel();
  const derivationIndex = derivationIndexOf(account);
  return {
    name: account.name,
    index: account.index,
    derivationIndex,
    derived: kernel.deriveAddress(mnemonic, "", chainJsonFor(chainId), derivationIndex),
  };
}

function originWarnings(origin: string): string[] {
  return assessOrigin(origin).warnings;
}

/**
 * The longest "Raw transaction" a prompt is handed, in characters, as the prompt spells it out.
 * Far above any transaction a chain takes: CometBFT's default mempool limit is 1 MiB a
 * transaction, and the largest message there is, a contract upload, carries at most 800 KiB of
 * wasm under wasmd's default.
 */
const PREVIEW_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Pretty JSON for the approval screen, always whole. Bytes stay a length, so a Direct doc stays
 * readable. A transaction that cannot be shown whole is refused, never cut: padding placed ahead
 * of a packet memo's receiver or a contract's would push what decides where the funds go out of
 * the text the prompt tells the user to check.
 */
function previewJson(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof Uint8Array) return `${item.length} bytes`;
        return item;
      },
      2,
    );
  } catch {
    text = undefined;
  }
  if (text === undefined) throw new ProviderError("UNSUPPORTED", "This transaction cannot be shown in full");
  if (text.length > PREVIEW_MAX_CHARS) {
    throw new ProviderError("UNSUPPORTED", "This transaction is too large to show in full");
  }
  return text;
}

/**
 * The refusal a site gets when a document holds a message Zunia cannot read
 * and blind signing is off. Keeps the sentence sites already match on, and
 * names each unreadable type so the site (and its user) knows which one.
 */
export function blindSigningRefusal(summary: {
  messages: Array<{ type: string; unknown?: boolean }>;
}): ProviderError {
  const named = summary.messages.filter((m) => m.unknown).map((m) => m.type.trim());
  const types = [...new Set(named.filter(Boolean))]
    .map((type) => (type.length > 128 ? `${type.slice(0, 127)}…` : type))
    .slice(0, 5);
  return new ProviderError(
    "UNSUPPORTED",
    `Blind signing disabled for unknown messages${types.length > 0 ? `: ${types.join(", ")}` : ""}`,
  );
}

/**
 * After an approval, every address the prompt named as a recipient (a send's,
 * a transfer's receiver, an NFT's new owner or the contract handed it), in
 * either sign mode, so paying it again is not "first-time". Every message, so
 * a multi-send teaches the address book every recipient, not the first one N
 * times.
 */
async function rememberRecipients(summary: SignSafetySummary): Promise<void> {
  for (const message of summary.messages) {
    if (message.recipient) await rememberRecipient(message.recipient);
  }
}

/** Record a use of the grant. Bookkeeping only: it never fails the request. */
function noteUse(origin: string, exposure?: { chainId: string; address: string }): void {
  void touchPermission(origin, exposure).catch(() => undefined);
}

type NewApproval = Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt">;

/** Queue a request for the popup, bring the popup up, and wait for the answer. */
async function approveInPopup(request: NewApproval): Promise<{ feeTier?: unknown }> {
  const { result } = enqueueApprovalWithId({ ...request, host: "popup" });
  void openApprovalUi();
  const answer = (await result) as { approved?: boolean; feeTier?: unknown } | undefined;
  if (!answer?.approved) throw new ProviderError("USER_REJECTED", "Request rejected");
  return answer;
}

/** The tier the user picked, when it differs from the fee the site set. */
function pickedTier(choice: FeeChoice | null, answer: { feeTier?: unknown }): FeeTier | null {
  if (!choice || !isFeeTier(answer.feeTier)) return null;
  return choice.tiers[answer.feeTier] === choice.site ? null : answer.feeTier;
}

/**
 * After the user approves, the session and the active account are read again:
 * the wallet may have locked, or the user may have switched accounts in the
 * popup while the prompt was open. Either way the key checked before the prompt
 * is no longer the key that would sign.
 */
async function keyAfterApproval(
  chainId: string,
  signer: string,
  expectedIndex: number,
): Promise<{ mnemonic: string; key: ActiveKey }> {
  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new ProviderError("LOCKED", "Wallet locked before signing");
  const key = await activeKey(mnemonic, chainId);
  if (key.index !== expectedIndex) {
    throw invalidParams(
      "The active account changed while the request was open. Ask the site to try again.",
    );
  }
  assertSigner(signer, key.derived.bech32Address);
  return { mnemonic, key };
}

function secpSignature(pubKey: Uint8Array, signatureHex: string) {
  return {
    pub_key: {
      type: "tendermint/PubKeySecp256k1",
      value: toBase64(pubKey),
    },
    signature: toBase64(hexToBytes(signatureHex)),
  };
}

function normalizeChainIds(chainIds: unknown): string[] {
  const list = Array.isArray(chainIds) ? chainIds : [chainIds];
  const out = list.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  return [...new Set(out)];
}

type PublicChainInfo = Omit<ChainInfo, "rpc" | "rest"> & {
  bech32Config: {
    bech32PrefixAccAddr: string;
    bech32PrefixAccPub: string;
    bech32PrefixValAddr: string;
    bech32PrefixValPub: string;
    bech32PrefixConsAddr: string;
    bech32PrefixConsPub: string;
  };
};

function toPublicChainInfo(info: ChainInfo): PublicChainInfo {
  const { rpc: _rpc, rest: _rest, ...rest } = info;
  const p = info.bech32Prefix;
  return {
    ...rest,
    bech32Config: {
      bech32PrefixAccAddr: p,
      bech32PrefixAccPub: `${p}pub`,
      bech32PrefixValAddr: `${p}valoper`,
      bech32PrefixValPub: `${p}valoperpub`,
      bech32PrefixConsAddr: `${p}valcons`,
      bech32PrefixConsPub: `${p}valconspub`,
    },
  };
}

/** Chains a page may learn about. Never includes endpoints: a user's own node URL can carry a key. */
async function publicChainInfos(): Promise<PublicChainInfo[]> {
  await ensureCatalog();
  const custom = await listCustomChains();
  const map = new Map<string, PublicChainInfo>();
  for (const info of BUILTIN_CHAINS) map.set(info.chainId, toPublicChainInfo(info));
  for (const entry of custom) map.set(entry.chainId, toPublicChainInfo(toChainInfo(entry)));
  return [...map.values()];
}

interface ProviderRequest {
  origin: string;
  method: ProviderMethod;
  args: unknown[];
  /** Tab the request came from, when it came through a content script. */
  tabId?: number;
}

/**
 * Runs one provider call. Every failure leaves as a {@link ProviderError}
 * (or carries a `code`), so the page can tell a refusal from a bad argument.
 */
export async function handleProviderRequest(input: ProviderRequest): Promise<unknown> {
  try {
    return await dispatchProviderRequest(input);
  } catch (err) {
    if (err instanceof ProviderGuardError || err instanceof ChainDraftError) {
      throw invalidParams(err.message);
    }
    throw err;
  }
}

async function dispatchProviderRequest(input: ProviderRequest): Promise<unknown> {
  const { origin, method, args, tabId } = input;

  switch (method) {
    case "enable": {
      const chainIds = normalizeChainIds(args[0]);
      if (chainIds.length === 0) throw invalidParams("chainId required");
      for (const chainId of chainIds) await requireKnownChain(chainId);

      const wasLocked = !(await isUnlocked());
      if (wasLocked) await waitForUnlock();
      if (await hasPermission(origin, chainIds)) {
        noteUse(origin);
        return null;
      }

      const joined = findPendingEnable(origin, tabId);
      let result: Promise<unknown>;
      if (joined) {
        extendApprovalChains(joined.id, chainIds);
        result = joined.result;
      } else {
        const queued = enqueueApprovalWithId({
          kind: "enable",
          origin,
          chainIds,
          tabId,
          title: `Connect to ${origin}`,
          detail: { chainIds },
          warnings: originWarnings(origin),
        });
        result = queued.result;
        // Connection prompts render over the page so the choice stays next to
        // the site asking for it, but only when the popup is not already the
        // place the user is looking. Signing never renders in-page, and
        // neither does a prompt for a lookalike site: the page it would sit
        // on is the one under suspicion.
        const inPage =
          !wasLocked &&
          !approvalUiOpen() &&
          assessOrigin(origin).level !== "suspicious" &&
          (await showConnectOverlay(tabId, queued.id, origin));
        setApprovalHost(queued.id, inPage ? "overlay" : "popup");
        if (!inPage) void openApprovalUi();
      }

      const approved = (await result) as { approved?: boolean } | undefined;
      if (!approved?.approved) throw new ProviderError("USER_REJECTED", "Request rejected");
      await grantPermission(origin, chainIds);
      return null;
    }

    case "getConnectedChains": {
      // Read-only and silent: this is how a page restores its session on
      // reload without opening the unlock window.
      const chainIds = await connectedChains(origin);
      if (chainIds.length > 0) noteUse(origin);
      return chainIds;
    }

    case "isLocked": {
      // Only a connected site hears whether the user is at the wallet.
      if ((await connectedChains(origin)).length === 0) {
        throw new ProviderError("NOT_CONNECTED", "Not authorized");
      }
      return !(await isUnlocked());
    }

    case "disable": {
      if (args[0] === undefined || args[0] === null) {
        await revokePermission(origin);
        return null;
      }
      for (const chainId of normalizeChainIds(args[0])) {
        await revokeChain(origin, chainId);
      }
      return null;
    }

    case "getKey": {
      const chainId = requireChainId(args[0]);
      await requirePermission(origin, chainId);
      const mnemonic = await unlockedMnemonic();
      const key = await activeKey(mnemonic, chainId);
      noteUse(origin, { chainId, address: key.derived.bech32Address });
      const ethHex = findCatalogEntry(chainId)?.features?.includes("eth-address-gen")
        ? ethereumHexAddress(key.derived.bech32Address)
        : undefined;
      return {
        name: key.name,
        algo: key.derived.algo,
        pubKey: Array.from(key.derived.pubKey),
        address: key.derived.address,
        bech32Address: key.derived.bech32Address,
        isNanoLedger: false,
        ...(ethHex ? { ethereumHexAddress: ethHex } : {}),
      };
    }

    case "getAccounts": {
      // The offline signer always passes its chain. Without one there is no
      // grant to check, so there is nothing to answer.
      const chainId = requireChainId(args[0]);
      await requirePermission(origin, chainId);
      const mnemonic = await unlockedMnemonic();
      const key = await activeKey(mnemonic, chainId);
      noteUse(origin, { chainId, address: key.derived.bech32Address });
      return [
        {
          address: key.derived.bech32Address,
          algo: key.derived.algo,
          pubkey: Array.from(key.derived.pubKey),
        },
      ];
    }

    case "signAmino": {
      const chainId = requireChainId(args[0]);
      const signer = args[1];
      const signDoc = args[2];
      const options = signOptionsFrom(args[3]);
      await requirePermission(origin, chainId);
      assertSameChain(chainId, aminoSignDocChainId(signDoc));
      const mnemonic = await unlockedMnemonic();
      const before = await activeKey(mnemonic, chainId);
      assertSigner(signer, before.derived.bech32Address);

      const summary = await decodeAminoSignDoc(chainId, signDoc);
      if (summary.requiresBlindSigning) {
        throw blindSigningRefusal(summary);
      }
      const feeChoice = feeChoiceFor(chainId, aminoFeeOf(signDoc), options);
      const answer = await approveInPopup({
        kind: "signAmino",
        origin,
        chainIds: [chainId],
        tabId,
        title: `Sign transaction on ${chainId}`,
        detail: {
          signer,
          summary,
          json: previewJson(signDoc),
          ...(feeChoice ? { feeChoice } : {}),
        },
        warnings: [...originWarnings(origin), ...summary.warnings],
      });

      const { mnemonic: current, key } = await keyAfterApproval(
        chainId,
        signer as string,
        before.index,
      );

      await rememberRecipients(summary);

      // The site reads the fee back from `signed`, as CosmJS does, so a
      // tier the user picked is what gets broadcast.
      const tier = pickedTier(feeChoice, answer);
      const signed =
        tier && feeChoice
          ? withAminoFee(signDoc as { fee?: unknown }, {
              denom: feeChoice.denom,
              amount: feeChoice.tiers[tier],
            })
          : signDoc;

      const kernel = await loadKernel();
      const signatureHex = kernel.signCosmos(
        current,
        "",
        chainJsonFor(chainId),
        key.derivationIndex,
        bytesToHex(serializeAminoSignDoc(signed)),
      );
      noteUse(origin, { chainId, address: key.derived.bech32Address });
      return {
        signed,
        signature: secpSignature(key.derived.pubKey, signatureHex),
      };
    }

    case "signDirect": {
      const chainId = requireChainId(args[0]);
      const signer = args[1];
      const options = signOptionsFrom(args[3]);
      await requirePermission(origin, chainId);
      const doc = normalizeDirectSignDoc(args[2]);
      assertSameChain(chainId, doc.chainId);
      const signBytes = encodeDirectSignDoc(doc);
      const mnemonic = await unlockedMnemonic();
      const before = await activeKey(mnemonic, chainId);
      assertSigner(signer, before.derived.bech32Address);

      const summary = await decodeDirectSignBytes(chainId, signBytes);
      if (summary.requiresBlindSigning) {
        throw blindSigningRefusal(summary);
      }
      const feeChoice = feeChoiceFor(chainId, authInfoFee(doc.authInfoBytes), options);
      const answer = await approveInPopup({
        kind: "signDirect",
        origin,
        chainIds: [chainId],
        tabId,
        title: `Sign transaction on ${chainId}`,
        detail: {
          signer,
          summary,
          // The transaction as decoded: the fee as signed, every coin of it,
          // and each message with what its summary leaves out, a contract
          // call's message and coins, a transfer's packet memo.
          json: previewJson({
            chainId: summary.chainId,
            memo: summary.memo ?? "",
            fee: summary.fee ?? null,
            messages: summary.messages,
          }),
          ...(feeChoice ? { feeChoice } : {}),
        },
        warnings: [...originWarnings(origin), ...summary.warnings],
      });

      const { mnemonic: current, key } = await keyAfterApproval(
        chainId,
        signer as string,
        before.index,
      );
      await rememberRecipients(summary);

      const tier = pickedTier(feeChoice, answer);
      let signedDoc = doc;
      if (tier && feeChoice) {
        const coin = { denom: feeChoice.denom, amount: feeChoice.tiers[tier] };
        signedDoc = { ...doc, authInfoBytes: withAuthInfoFee(doc.authInfoBytes, coin) };
        // Read the rewritten bytes back: only the fee coin may differ.
        const check = authInfoFee(signedDoc.authInfoBytes);
        const [paid, ...extra] = check?.amount ?? [];
        if (
          check?.gas !== feeChoice.gas ||
          extra.length > 0 ||
          paid?.denom !== coin.denom ||
          paid.amount !== coin.amount
        ) {
          throw new Error("Zunia could not change the fee safely, so nothing was signed.");
        }
      }

      const kernel = await loadKernel();
      const signatureHex = kernel.signCosmos(
        current,
        "",
        chainJsonFor(chainId),
        key.derivationIndex,
        bytesToHex(signedDoc === doc ? signBytes : encodeDirectSignDoc(signedDoc)),
      );
      noteUse(origin, { chainId, address: key.derived.bech32Address });
      return {
        signed: directSignDocToWire(signedDoc),
        signature: secpSignature(key.derived.pubKey, signatureHex),
        feeChanged: signedDoc !== doc,
      };
    }

    case "signArbitrary": {
      const chainId = requireChainId(args[0]);
      const signer = args[1];
      const data = args[2];
      if (typeof signer !== "string" || !signer) throw invalidParams("signer required");
      if (data == null) throw invalidParams("data required");
      await requirePermission(origin, chainId);
      const dataBytes = dataToBytes(data);
      if (!adr36PayloadIsSafe(dataBytes)) {
        throw invalidParams("ADR-36 data looks like a transaction sign doc; refusing to sign");
      }
      const signIn = signInFor(dataBytes, { origin, chainId, signer });
      const mnemonic = await unlockedMnemonic();
      const before = await activeKey(mnemonic, chainId);
      assertSigner(signer, before.derived.bech32Address);

      await approveInPopup({
        kind: "signArbitrary",
        origin,
        chainIds: [chainId],
        tabId,
        title: signIn ? `Sign in to ${signIn.message.domain}` : `Sign message on ${chainId}`,
        detail: {
          signer,
          preview: previewText(dataBytes),
          encoding: typeof data === "string" ? "utf8" : "bytes",
          ...(signIn ? { signIn: signIn.message, message: signIn.text } : {}),
        },
        warnings: originWarnings(origin),
      });

      const { mnemonic: current, key } = await keyAfterApproval(
        chainId,
        signer,
        before.index,
      );
      const kernel = await loadKernel();
      const signatureHex = kernel.signCosmos(
        current,
        "",
        chainJsonFor(chainId),
        key.derivationIndex,
        adr36SignBytesHex(signer, dataBytes),
      );
      noteUse(origin, { chainId, address: key.derived.bech32Address });
      // Keplr's contract: the StdSignature itself, which is what cosmos-kit,
      // graz and the Zunia SDK pass to their ADR-36 verifiers.
      return secpSignature(key.derived.pubKey, signatureHex);
    }

    case "verifyArbitrary": {
      const chainId = requireChainId(args[0]);
      const signer = String(args[1] ?? "");
      const data = args[2];
      const signatureArg = args[3] as
        | {
            pub_key?: { type?: string; value?: string };
            signature?: string;
          }
        | string
        | undefined;
      if (!signer || data == null || signatureArg == null) {
        throw invalidParams("chainId, signer, data, and signature required");
      }
      await requirePermission(origin, chainId);

      const dataBytes = dataToBytes(data);
      if (!adr36PayloadIsSafe(dataBytes)) return false;

      let pubKeyBytes: Uint8Array;
      let sigBytes: Uint8Array;
      if (typeof signatureArg === "string") {
        const mnemonic = await getSessionMnemonic();
        if (!mnemonic) throw new ProviderError("LOCKED", "Wallet is locked");
        const key = await activeKey(mnemonic, chainId);
        pubKeyBytes = key.derived.pubKey;
        sigBytes = wireBytesOf(signatureArg, "signature");
      } else {
        if (!signatureArg.pub_key?.value || !signatureArg.signature) {
          throw invalidParams("signature.pub_key.value and signature.signature required");
        }
        pubKeyBytes = wireBytesOf(signatureArg.pub_key.value, "pub_key");
        sigBytes = wireBytesOf(signatureArg.signature, "signature");
      }

      return verifyAdr36(signer, dataBytes, pubKeyBytes, sigBytes);
    }

    case "sendTx": {
      // Wallet-originated txs broadcast via LCD from the popup; dApp sendTx
      // stays unsupported so the extension never holds a dApp-supplied payload
      // as the broadcaster of record.
      throw new ProviderError(
        "UNSUPPORTED",
        "Zunia does not broadcast dApp transactions. Request a signature with " +
          "signAmino or signDirect and broadcast it from the dApp.",
      );
    }

    case "experimentalSuggestChain": {
      const draft = draftFromSuggestedChain(args[0]);
      await ensureCatalog();
      // Already known, from the registry or an earlier suggestion: nothing to ask.
      if (findCatalogEntry(draft.chainId)) return null;
      await approveInPopup({
        kind: "suggestChain",
        origin,
        chainIds: [draft.chainId],
        tabId,
        title: `Add ${draft.chainName}`,
        detail: { draft },
        warnings: [
          ...originWarnings(origin),
          "Balances and transactions for this network will go through the endpoints below, which this site chose.",
        ],
      });
      await saveCustomChain(draft);
      return null;
    }

    case "getChainInfos":
    case "getChainInfosWithoutEndpoints":
      return publicChainInfos();

    default:
      throw new ProviderError("UNSUPPORTED", `Method not implemented: ${String(method)}`);
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
