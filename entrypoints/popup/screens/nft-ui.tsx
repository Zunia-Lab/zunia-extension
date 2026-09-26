/**
 * Pieces shared by the two NFT screens.
 *
 * Everything chain-facing is `@zunialab/interchain` through `lib/nft.ts`;
 * everything visual is `@zunialab/ui`. What is left - the hooks that hold a
 * discovery run while the user edits a form, the two host-config editors, and
 * the panel that says what a CW721 execute message will do - lives here so the
 * list screen and the detail screen cannot drift apart.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Input,
  KeyValueRow,
  SectionLabel,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { BuiltMsg } from "@zunialab/interchain";

import {
  addUserContract,
  describeNftExecute,
  discoverCollections,
  listUserContracts,
  nftChainSupport,
  probeUserContract,
  removeUserContract,
  setNftBridgeAddress,
  verifyNftBridge,
  type NftBridgeCheck,
  type NftChainSupport,
  type NftExecuteDescription,
  type NftListResult,
} from "../../../lib/nft";
import { describeInterchainError } from "../../../lib/interchain";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { TruncatedValue } from "./interchain-ui";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { IconTrash } from "./icons";

/* -------------------------------------------------------------------------- *
 * The two privacy gates
 * -------------------------------------------------------------------------- */

/** Whether artwork may be fetched, and the exact reason when it may not. */
export interface NftMediaGate {
  /** True only when both switches are on. Passed straight to `loadMedia`. */
  readonly enabled: boolean;
  /** True when flipping the artwork switch is enough to enable it. */
  readonly togglable: boolean;
  /** Why the switch is unavailable. `null` when it is available. */
  readonly blockedReason: string | null;
  readonly setEnabled: (next: boolean) => void;
}

/**
 * The artwork switch.
 *
 * Two conditions, not one. `liveBalances` is the wallet-wide "may Zunia touch
 * the network" preference; `nftMedia` is the narrower "may Zunia touch a host
 * the NFT names". Artwork needs both, and when live reads are off the artwork
 * switch is not offered at all - turning it on there would promise something
 * the wallet would then refuse to do.
 */
export function useNftMediaGate(): NftMediaGate {
  const { settings, update } = usePrefs();
  const setEnabled = useCallback(
    (next: boolean) => void update({ nftMedia: next }),
    [update],
  );
  if (!settings.liveBalances) {
    return {
      enabled: false,
      togglable: false,
      blockedReason:
        "Artwork is a network read, and live reads are off. Turn on live balances in Settings, Preferences first.",
      setEnabled,
    };
  }
  return {
    enabled: settings.nftMedia,
    togglable: true,
    blockedReason: null,
    setEnabled,
  };
}

/* -------------------------------------------------------------------------- *
 * Chains that can hold NFTs
 * -------------------------------------------------------------------------- */

/** Enabled chains split by whether they declare `cosmwasm`. */
export function useNftChains(chains: readonly ChainAccountView[]): {
  supported: readonly ChainAccountView[];
  unsupported: readonly { chain: ChainAccountView; support: NftChainSupport }[];
} {
  return useMemo(() => {
    const supported: ChainAccountView[] = [];
    const unsupported: { chain: ChainAccountView; support: NftChainSupport }[] = [];
    for (const chain of chains) {
      const support = nftChainSupport(chain.chainId);
      if (support.supported) supported.push(chain);
      else unsupported.push({ chain, support });
    }
    return { supported, unsupported };
  }, [chains]);
}

/* -------------------------------------------------------------------------- *
 * Discovery
 * -------------------------------------------------------------------------- */

/** The state of one discovery run, held while the user edits the screen. */
export interface NftDiscoveryState {
  readonly result: NftListResult | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => void;
}

/**
 * Run discovery for one chain and owner.
 *
 * `result` stays `null` until a run has really finished, so no caller can read
 * "nothing yet" as "holds nothing". `loading` is derived from which request the
 * hook should be showing rather than stored, which is the pattern the rest of
 * this popup uses to avoid a second render per load.
 */
export function useNftDiscovery(input: {
  chainId: string | null;
  owner: string | null;
  enabled: boolean;
}): NftDiscoveryState {
  const [token, setToken] = useState(0);
  const requestKey =
    input.enabled && input.chainId && input.owner
      ? `${input.chainId}:${input.owner}:${token}`
      : "";
  const [settled, setSettled] = useState<{
    requestKey: string;
    result: NftListResult | null;
    error: string | null;
  } | null>(null);

  const chainId = input.chainId;
  const owner = input.owner;
  useEffect(() => {
    if (!requestKey || !chainId || !owner) return;
    const controller = new AbortController();
    void discoverCollections(chainId, owner, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setSettled({ requestKey, result, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ requestKey, result: null, error: describeInterchainError(error) });
      });
    return () => controller.abort();
  }, [requestKey, chainId, owner]);

  const reload = useCallback(() => setToken((n) => n + 1), []);
  const current = settled?.requestKey === requestKey ? settled : null;
  return {
    result: current?.result ?? null,
    loading: Boolean(requestKey) && current === null,
    error: current?.error ?? null,
    reload,
  };
}

/** One finished discovery run, tagged with the chain it was asked on. */
export interface NftChainDiscovery {
  readonly chainId: string;
  readonly result: NftListResult | null;
  readonly error: string | null;
}

/**
 * Ask every CosmWasm chain the wallet has an address on, in parallel.
 *
 * The list screen shows every token that comes back, then the user can filter
 * to one network. A chain that was never asked is not treated as empty.
 */
export function useNftDiscoveryAll(input: {
  chains: readonly ChainAccountView[];
  enabled: boolean;
}): {
  rows: readonly NftChainDiscovery[];
  loading: boolean;
  reload: () => void;
} {
  const [token, setToken] = useState(0);
  const targets = useMemo(
    () =>
      input.chains
        .filter((chain) => nftChainSupport(chain.chainId).supported && chain.address)
        .map((chain) => ({ chainId: chain.chainId, owner: chain.address })),
    [input.chains],
  );
  const requestKey = input.enabled
    ? `${token}|${targets.map((row) => `${row.chainId}:${row.owner}`).join(",")}`
    : "";
  const [settled, setSettled] = useState<{
    requestKey: string;
    rows: NftChainDiscovery[];
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (!requestKey || targets.length === 0) return;
    const controller = new AbortController();
    const rows: NftChainDiscovery[] = [];
    void Promise.all(
      targets.map(async (target) => {
        try {
          const result = await discoverCollections(target.chainId, target.owner, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            rows.push({ chainId: target.chainId, result, error: null });
            setSettled({ requestKey, rows: [...rows], done: false });
          }
        } catch (error: unknown) {
          if (controller.signal.aborted) return;
          rows.push({
            chainId: target.chainId,
            result: null,
            error: describeInterchainError(error),
          });
          setSettled({ requestKey, rows: [...rows], done: false });
        }
      }),
    ).then(() => {
      if (!controller.signal.aborted) {
        setSettled({ requestKey, rows: [...rows], done: true });
      }
    });
    return () => controller.abort();
  }, [requestKey, targets]);

  const reload = useCallback(() => setToken((n) => n + 1), []);
  const current = settled?.requestKey === requestKey ? settled : null;
  return {
    rows: current?.rows ?? [],
    loading: Boolean(requestKey) && !current?.done,
    reload,
  };
}

/** Failed lookups only. A quiet scan is not announced. */
export function ScanDisclosure({
  result,
  chainName,
}: {
  result: NftListResult;
  chainName: string;
}) {
  if (result.issues.length === 0) return null;
  return (
    <Callout tone="warning" title={`Some lookups failed on ${chainName}`}>
      <ul className="flex flex-col gap-1">
        {result.issues.map((issue) => (
          <li key={`${issue.contractAddress ?? "indexer"}-${issue.message}`}>
            {issue.contractAddress
              ? `${truncateAddress(issue.contractAddress, 8, 6)}: ${issue.message}`
              : issue.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * Where one collection came from.
 *
 * Worth a pill of its own: when a list looks wrong, "you added this one" and
 * "Zunia shipped this one" send the user to different places.
 */
export function SourcePill({
  source,
}: {
  source: "known" | "indexer" | "user" | "module";
}) {
  const label =
    source === "user"
      ? "You added"
      : source === "indexer"
        ? "Indexed"
        : source === "module"
          ? "On chain"
          : "Shipped";
  return (
    <span className="shrink-0 rounded-full border border-[var(--z-line)] px-2 py-[2px] font-mono text-[8.5px] uppercase tracking-[0.1em] text-fg-dim">
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * The contract list the user owns
 * -------------------------------------------------------------------------- */

function chainFamilyName(chainName: string): string {
  return (
    chainName
      .replace(/\s*\([^)]*testnet[^)]*\)/i, "")
      .replace(/\s+(public\s+)?(testnet|devnet)\b.*/i, "")
      .trim() || chainName
  );
}

function networkChoiceLabel(
  chain: ChainAccountView,
  siblings: readonly ChainAccountView[],
): string {
  const base = chain.entry.network === "mainnet" ? "Mainnet" : "Testnet";
  const sameKind = siblings.filter((row) => row.entry.network === chain.entry.network);
  return sameKind.length > 1 ? `${base} · ${chain.chainId}` : base;
}

/**
 * Add a collection the scan missed. Chain and network pick the chain id, then
 * Test has to hear the contract answer before Add turns on.
 */
export function ContractManager({
  chains,
  onChanged,
}: {
  chains: readonly ChainAccountView[];
  onChanged: () => void;
}) {
  const families = useMemo(() => {
    const grouped = new Map<string, ChainAccountView[]>();
    for (const chain of chains) {
      const name = chainFamilyName(chain.entry.chainName);
      const rows = grouped.get(name) ?? [];
      rows.push(chain);
      grouped.set(name, rows);
    }
    return [...grouped.entries()]
      .map(([name, options]) => ({
        name,
        options: [...options].sort((a, b) => {
          if (a.entry.network === b.entry.network) return a.chainId.localeCompare(b.chainId);
          return a.entry.network === "mainnet" ? -1 : 1;
        }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [chains]);

  const [familyName, setFamilyName] = useState(families[0]?.name ?? "");
  const family = families.find((row) => row.name === familyName) ?? families[0];
  const [chainId, setChainId] = useState(family?.options[0]?.chainId ?? "");
  const selected =
    family?.options.find((row) => row.chainId === chainId) ?? family?.options[0];
  const activeChainId = selected?.chainId ?? "";

  const [contracts, setContracts] = useState<readonly string[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tested, setTested] = useState<{ chainId: string; address: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const chainFieldId = useId();
  const networkFieldId = useId();
  const proven =
    tested?.chainId === activeChainId &&
    tested.address === value.trim() &&
    value.trim().length > 0;

  useEffect(() => {
    if (!activeChainId) return;
    let cancelled = false;
    void listUserContracts(activeChainId).then((rows) => {
      if (!cancelled) setContracts(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [activeChainId]);

  function clearProof() {
    setTested(null);
    setNote(null);
    setError(null);
  }

  async function testContract() {
    if (!activeChainId) return;
    setTesting(true);
    clearProof();
    const outcome = await probeUserContract(activeChainId, value);
    setTesting(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setTested({ chainId: activeChainId, address: value.trim() });
    setNote(outcome.name ? `${outcome.name} answered.` : "Contract answered.");
  }

  async function add() {
    if (!activeChainId || !proven) return;
    setBusy(true);
    setError(null);
    const outcome = await addUserContract(activeChainId, value);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }
    setContracts(outcome.contracts);
    setValue("");
    setTested(null);
    setNote(null);
    onChanged();
  }

  async function remove(address: string) {
    if (!activeChainId) return;
    setContracts(await removeUserContract(activeChainId, address));
    onChanged();
  }

  if (!family || !selected) return null;

  return (
    <details className="rounded-[13px] border border-[var(--z-line)] px-3 py-2">
      <summary
        className={cn(
          "cursor-pointer text-[12px] font-medium text-fg-muted",
          focusRing,
        )}
      >
        Missing a collection?
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="m-0 text-[10.5px] leading-snug text-fg-muted">
          Paste a contract only if a collection never showed up. Test it, then add it.
        </p>
        {contracts.length > 0 ? (
          <ul className="flex flex-col divide-y divide-[var(--z-line)] rounded-[13px] border border-[var(--z-line)] px-2.5">
            {contracts.map((address) => (
              <li key={address} className="flex items-center gap-2 py-2">
                <span
                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg"
                  title={address}
                >
                  {truncateAddress(address, 12, 8)}
                </span>
                <button
                  type="button"
                  aria-label={`Stop tracking ${address}`}
                  onClick={() => void remove(address)}
                  className={cn(
                    "shrink-0 rounded-[8px] p-1 text-fg-dim hover:bg-[var(--z-state-hover)] hover:text-fg",
                    focusRing,
                  )}
                >
                  <IconTrash width={14} height={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="flex flex-col gap-1" htmlFor={chainFieldId}>
          <span className="text-[11px] font-medium text-fg-muted">Chain</span>
          <select
            id={chainFieldId}
            value={family.name}
            onChange={(event) => {
              const next = families.find((row) => row.name === event.target.value);
              setFamilyName(event.target.value);
              setChainId(next?.options[0]?.chainId ?? "");
              clearProof();
            }}
            className="w-full rounded-[12px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5 text-[13px] text-fg outline-none focus-visible:shadow-[0_0_0_1px_var(--z-focus-ring)]"
          >
            {families.map((row) => (
              <option key={row.name} value={row.name}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1" htmlFor={networkFieldId}>
          <span className="text-[11px] font-medium text-fg-muted">Network</span>
          <select
            id={networkFieldId}
            value={activeChainId}
            onChange={(event) => {
              setChainId(event.target.value);
              clearProof();
            }}
            className="w-full rounded-[12px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5 text-[13px] text-fg outline-none focus-visible:shadow-[0_0_0_1px_var(--z-focus-ring)]"
          >
            {family.options.map((row) => (
              <option key={row.chainId} value={row.chainId}>
                {networkChoiceLabel(row, family.options)}
              </option>
            ))}
          </select>
        </label>
        <Input
          id={fieldId}
          label="Collection contract"
          placeholder={`${selected.entry.bech32Prefix}1…`}
          value={value}
          spellCheck={false}
          autoComplete="off"
          state={error ? "error" : proven ? "valid" : "default"}
          hint={error ?? note ?? undefined}
          onChange={(event) => {
            setValue(event.target.value);
            clearProof();
          }}
        />
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={testing || busy || value.trim().length === 0}
            onClick={() => void testContract()}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button size="sm" disabled={!proven || busy || testing} onClick={() => void add()}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>
    </details>
  );
}

/* -------------------------------------------------------------------------- *
 * The ICS721 bridge
 * -------------------------------------------------------------------------- */

/**
 * The cw-ics721 bridge for a chain, checked against the chain.
 *
 * Same contract as `useSwapVenue`: the address is host configuration, the
 * shipped map is empty, and the cross-chain control stays off until a real
 * contract answers at the address.
 */
export function useNftBridge(
  chainId: string | null,
  enabled: boolean,
): { check: NftBridgeCheck | null; loading: boolean; recheck: () => void } {
  const [token, setToken] = useState(0);
  const requestKey = enabled && chainId ? `${chainId}:${token}` : "";
  const [settled, setSettled] = useState<{ requestKey: string; check: NftBridgeCheck } | null>(
    null,
  );

  useEffect(() => {
    if (!requestKey || !chainId) return;
    const controller = new AbortController();
    void verifyNftBridge(chainId, {
      signal: controller.signal,
      force: token > 0,
    }).then((check) => {
      if (!controller.signal.aborted) setSettled({ requestKey, check });
    });
    return () => controller.abort();
  }, [requestKey, chainId, token]);

  const recheck = useCallback(() => setToken((n) => n + 1), []);
  return {
    check: settled?.requestKey === requestKey ? settled.check : null,
    loading: Boolean(requestKey) && settled?.requestKey !== requestKey,
    recheck,
  };
}

/**
 * Pin a cw-ics721 bridge address for a chain.
 *
 * Offered because the shipped map is empty: without this the cross-chain path
 * is permanently unreachable, and a control that can never work is worse than
 * one that asks for the missing piece. What is entered is still checked on
 * chain before any `send_nft` is built.
 */
export function BridgeOverride({
  chainId,
  current,
  onSaved,
}: {
  chainId: string;
  current: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(current ?? "");
  const fieldId = useId();
  const entry = findCatalogEntry(chainId);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn("text-[10.5px] underline underline-offset-2", focusRing)}
      >
        {open ? "Cancel" : "Set a bridge contract address"}
      </button>
      {open ? (
        <div className="mt-2">
          <Input
            id={fieldId}
            label="cw-ics721 bridge contract"
            placeholder={`${entry?.bech32Prefix ?? "addr"}1…`}
            value={value}
            spellCheck={false}
            autoComplete="off"
            hint="Zunia checks this address on chain before it will build a cross-chain transfer."
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              className="flex-1"
              disabled={value.trim().length === 0}
              onClick={() => {
                void setNftBridgeAddress(chainId, value.trim()).then(() => {
                  setOpen(false);
                  onSaved();
                });
              }}
            >
              Check this address
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void setNftBridgeAddress(chainId, null).then(() => {
                  setValue("");
                  setOpen(false);
                  onSaved();
                });
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * The approval panel
 * -------------------------------------------------------------------------- */

/**
 * What the message about to be signed actually does.
 *
 * A CW721 transfer reaches the kernel as a `MsgExecuteContract`, and the
 * kernel's own preview line reads `Execute "transfer_nft" on juno1…`. That
 * names the action and nothing else - not the token, not the collection, not
 * the recipient - and "Execute contract" is not informed consent for giving
 * away a one-of-a-kind asset. So the message is decoded here and the three
 * facts that matter are stated as rows.
 *
 * When the decode fails the panel says so and shows the raw base64 payload
 * rather than describing a message it could not read.
 */
export function NftExecutePanel({
  msg,
  collectionName,
  tokenName,
  destChainName,
}: {
  msg: BuiltMsg;
  collectionName: string | null;
  tokenName: string | null;
  /** Only for a cross-chain transfer; names the chain the voucher is minted on. */
  destChainName?: string | null;
}) {
  const described: NftExecuteDescription | null = describeNftExecute(msg);

  if (!described) {
    const raw = msg.value["msg"];
    return (
      <section className="flex flex-col gap-2 rounded-[13px] border border-[var(--z-danger-line)] bg-[var(--z-danger-fill)] px-3 py-3">
        <SectionLabel>What this will do</SectionLabel>
        <p className="m-0 text-[11.5px] leading-snug text-fg">
          Zunia could not read this contract message, so it cannot tell you which
          token is leaving or who receives it. Do not approve it unless you know
          exactly what it does.
        </p>
        <pre className="m-0 max-h-[120px] overflow-auto whitespace-pre-wrap break-all font-mono text-[9.5px] leading-relaxed text-fg-muted">
          {typeof raw === "string" ? raw : JSON.stringify(msg.value)}
        </pre>
      </section>
    );
  }

  const { action, warnings } = described;
  return (
    <section className="flex flex-col gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
      <SectionLabel>What this will do</SectionLabel>
      <p className="m-0 text-[11.5px] leading-snug text-fg">
        {action.kind === "transfer_nft"
          ? `This gives token ${action.tokenId} away permanently. After it is signed the new owner controls it and Zunia cannot reverse it.`
          : `This hands token ${action.tokenId} to the bridge contract, which escrows it here and mints a voucher on ${destChainName ?? "the destination chain"}.`}
      </p>
      <div className="flex flex-col gap-1">
        {/* Every value goes through `TruncatedValue`: `KeyValueRow` does not
            truncate, and a CW721 token id is contract-chosen - a 60-character
            id would push a 360px popup into horizontal scroll on the one screen
            that must stay readable. The full text stays in the title, so it can
            still be read and copied. */}
        <KeyValueRow
          label="Token"
          value={
            <TruncatedValue>
              {tokenName ? `${tokenName} · ${action.tokenId}` : action.tokenId}
            </TruncatedValue>
          }
        />
        <KeyValueRow
          label="Collection"
          value={
            <TruncatedValue>
              {collectionName
                ? `${collectionName} · ${truncateAddress(action.collectionAddress, 6, 5)}`
                : truncateAddress(action.collectionAddress, 10, 8)}
            </TruncatedValue>
          }
        />
        {action.kind === "transfer_nft" ? (
          <KeyValueRow label="New owner" value={truncateAddress(action.recipient, 10, 8)} />
        ) : (
          <>
            <KeyValueRow
              label="Bridge contract"
              value={truncateAddress(action.receivingContract, 10, 8)}
            />
            {action.ics721 ? (
              <>
                <KeyValueRow
                  label="Voucher goes to"
                  value={truncateAddress(action.ics721.receiver, 10, 8)}
                />
                <KeyValueRow
                  label="Over channel"
                  value={<TruncatedValue>{action.ics721.channelId}</TruncatedValue>}
                />
              </>
            ) : null}
          </>
        )}
      </div>

      {action.kind === "send_nft" && !action.ics721 ? (
        <Callout tone="danger" title="Zunia cannot read the bridge payload">
          The message carries a payload for the receiving contract that does not
          look like an ICS721 transfer, so Zunia cannot say where this token ends
          up. The raw payload is:
          <span className="mt-1 block break-all font-mono text-[9.5px]">
            {action.innerJson}
          </span>
        </Callout>
      ) : null}

      {warnings.map((warning) => (
        <p key={warning} className="m-0 text-[10.5px] leading-snug text-[var(--z-warning)]">
          {warning}
        </p>
      ))}
    </section>
  );
}

/** A visible, specific reason a control is off. Never rendered empty. */
export function NftDisabledReason({ reason }: { reason: string | null }) {
  if (!reason) return null;
  return (
    <p className="mt-1.5 text-[10.5px] leading-snug text-fg-muted" role="status">
      {reason}
    </p>
  );
}
