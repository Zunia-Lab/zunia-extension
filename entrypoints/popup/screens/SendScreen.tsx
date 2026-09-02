import { useEffect, useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  Input,
  KeyValueRow,
  Pill,
  ScreenScaffold,
  Segmented,
  Spinner,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import type { AddressBookEntry } from "../../../lib/address-book";
import type {
  IbcChannelCheck,
  IbcChannelOption,
} from "../../../lib/ibc-channels";
import { normalizeChannelId } from "../../../lib/ibc-channels";
import {
  formatUnits,
  formatUnitsExact,
  isBech32,
  prefixOf,
} from "../../../lib/format";
import { sendToBackground } from "../../../lib/popup-client";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import {
  OverlayMenu,
  OverlayMenuItem,
} from "../components/OverlayMenu";
import {
  AddressBookPicker,
  AddressFieldActions,
  QrScanOverlay,
} from "../components/AddressFieldExtras";
import { IconChevronDown, IconSend } from "./icons";

const PERCENTS = [25, 50, 75, 100] as const;
type SendMode = "send" | "cross";

function toBaseUnits(input: string, decimals: number): bigint | null {
  if (!/^\d*\.?\d*$/.test(input) || input === "" || input === ".") return null;
  const [whole = "0", fraction = ""] = input.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function ChainOverlayPicker({
  label,
  chain,
  chains,
  balance,
  hidden,
  onSelect,
}: {
  label: string;
  chain?: ChainAccountView;
  chains: ChainAccountView[];
  balance?: ChainBalance;
  hidden: boolean;
  onSelect: (chainId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const decimals = chain?.entry.coinDecimals ?? 6;

  return (
    <section>
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {label}
      </p>
      <div className="relative mt-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-3 py-2.5 text-left",
            "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <Avatar
            src={chain?.iconUrl}
            fallback={chain?.entry.chainName ?? "?"}
            size={26}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-fg">
              {chain?.entry.coinDenom ?? "—"}
            </span>
            <span className="block truncate font-mono text-[9.5px] text-fg-dim">
              {chain?.entry.chainName ?? "Pick a network"}
            </span>
          </span>
          {balance ? (
            <span className="shrink-0 font-mono text-[10px] text-fg-dim">
              {hidden
                ? "••••"
                : `${formatUnits(balance.available, decimals)} free`}
            </span>
          ) : null}
          <IconChevronDown
            width={16}
            height={16}
            className={cn(
              "shrink-0 text-fg-dim transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        <OverlayMenu open={open} onClose={() => setOpen(false)}>
          {chains.map((option) => (
            <OverlayMenuItem
              key={option.chainId}
              selected={option.chainId === chain?.chainId}
              onSelect={() => {
                onSelect(option.chainId);
                setOpen(false);
              }}
            >
              <Avatar
                src={option.iconUrl}
                fallback={option.entry.chainName}
                size={20}
              />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg">
                {option.entry.chainName}
              </span>
              <span className="font-mono text-[9px] uppercase text-fg-dim">
                {option.entry.coinDenom}
              </span>
            </OverlayMenuItem>
          ))}
        </OverlayMenu>
      </div>
    </section>
  );
}

function ChannelPanel({
  sourceChainId,
  destChainId,
  channelId,
  onChannelId,
  options,
  loading,
  check,
}: {
  sourceChainId: string;
  destChainId: string;
  channelId: string;
  onChannelId: (id: string) => void;
  options: IbcChannelOption[];
  loading: boolean;
  check: IbcChannelCheck | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const selected = options.find((o) => o.channelId === channelId);

  return (
    <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
          IBC channel
        </p>
        {loading ? (
          <span className="flex items-center gap-1.5 font-mono text-[9px] text-fg-dim">
            <Spinner className="size-3" /> Finding…
          </span>
        ) : options.length > 0 ? (
          <span className="font-mono text-[9px] text-fg-dim">
            {options.length} open
          </span>
        ) : null}
      </div>

      {options.length > 1 ? (
        <div className="relative mt-2">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--z-line)] px-2.5 py-2 text-left",
              "hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
          >
            <span className="font-mono text-[12px] text-fg">
              {selected
                ? `${selected.channelId} → ${selected.counterpartyChannelId || "…"}`
                : "Choose a channel"}
            </span>
            <IconChevronDown width={14} height={14} className="text-fg-dim" />
          </button>
          <OverlayMenu open={pickerOpen} onClose={() => setPickerOpen(false)}>
            {options.map((option) => (
              <OverlayMenuItem
                key={option.channelId}
                selected={option.channelId === channelId}
                onSelect={() => {
                  onChannelId(option.channelId);
                  setPickerOpen(false);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[12px] text-fg">
                    {option.channelId}
                  </span>
                  <span className="block font-mono text-[9px] text-fg-dim">
                    counterparty {option.counterpartyChannelId || "—"}
                  </span>
                </span>
                <span className="font-mono text-[9px] uppercase text-[var(--z-success)]">
                  open
                </span>
              </OverlayMenuItem>
            ))}
          </OverlayMenu>
        </div>
      ) : null}

      {options.length === 1 && selected ? (
        <p className="mt-2 font-mono text-[12px] text-fg">
          {selected.channelId}
          <span className="ml-2 text-[10px] text-[var(--z-success)]">open</span>
        </p>
      ) : null}

      <Input
        className="mt-2"
        label={options.length > 0 ? "Or type a channel" : "Channel id"}
        placeholder="channel-141"
        value={channelId}
        spellCheck={false}
        autoComplete="off"
        state={
          !channelId
            ? "default"
            : check?.ok
              ? "valid"
              : check
                ? "error"
                : "default"
        }
        hint={
          check?.message ??
          (loading
            ? undefined
            : options.length === 0
              ? `No open route found from ${sourceChainId} to ${destChainId}. Enter one manually.`
              : undefined)
        }
        onChange={(e) => onChannelId(e.target.value)}
      />
    </section>
  );
}

export function SendScreen({
  chains,
  balances,
  initialChainId,
  contacts,
  onBack,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  contacts: AddressBookEntry[];
  onBack: () => void;
}) {
  const { hidden } = usePrefs();
  const [mode, setMode] = useState<SendMode>("send");
  const [chainId, setChainId] = useState(
    initialChainId ?? chains[0]?.chainId ?? "",
  );
  const [destChainId, setDestChainId] = useState(
    () =>
      chains.find((c) => c.chainId !== (initialChainId ?? chains[0]?.chainId))
        ?.chainId ??
      chains[1]?.chainId ??
      "",
  );
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channels, setChannels] = useState<IbcChannelOption[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelCheck, setChannelCheck] = useState<IbcChannelCheck | null>(
    null,
  );
  const [review, setReview] = useState(false);
  const [picker, setPicker] = useState<"book" | "qr" | null>(null);

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const destChain = chains.find((c) => c.chainId === destChainId);
  const balance = chain ? balances[chain.chainId] : undefined;
  const decimals = chain?.entry.coinDecimals ?? 6;
  const available = balance ? BigInt(balance.available) : null;
  const cross = mode === "cross";

  useEffect(() => {
    if (!cross || !chain || !destChainId || chain.chainId === destChainId) {
      setChannels([]);
      setChannelsLoading(false);
      return;
    }
    let cancelled = false;
    setChannelsLoading(true);
    setChannelCheck(null);
    void sendToBackground<IbcChannelOption[]>("FIND_IBC_CHANNELS", {
      sourceChainId: chain.chainId,
      destChainId,
    })
      .then((rows) => {
        if (cancelled) return;
        setChannels(rows);
        if (rows.length === 1) setChannelId(rows[0]!.channelId);
        else if (
          rows.length > 1 &&
          !rows.some((r) => r.channelId === normalizeChannelId(channelId))
        ) {
          setChannelId("");
        }
      })
      .catch(() => {
        if (!cancelled) setChannels([]);
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally omit channelId so discovery is not re-run while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cross, chain?.chainId, destChainId]);

  useEffect(() => {
    if (!cross || !chain || !channelId.trim()) {
      setChannelCheck(null);
      return;
    }
    const normalized = normalizeChannelId(channelId);
    const known = channels.find((c) => c.channelId === normalized);
    if (known) {
      setChannelCheck({
        ok: true,
        state: "open",
        channelId: known.channelId,
        portId: known.portId,
        counterpartyChannelId: known.counterpartyChannelId,
        counterpartyChainId: known.counterpartyChainId,
        message: `Open · ${known.counterpartyChainId ?? destChainId}`,
      });
      return;
    }
    const handle = window.setTimeout(() => {
      void sendToBackground<IbcChannelCheck>("VALIDATE_IBC_CHANNEL", {
        sourceChainId: chain.chainId,
        channelId: normalized,
        destChainId,
      }).then(setChannelCheck);
    }, 400);
    return () => window.clearTimeout(handle);
  }, [cross, chain, channelId, channels, destChainId]);

  const expectedPrefix = cross
    ? destChain?.entry.bech32Prefix
    : chain?.entry.bech32Prefix;

  const recipientState = useMemo(() => {
    const value = recipient.trim();
    if (!value) return { tone: "default" as const, hint: undefined };
    if (!isBech32(value)) {
      return { tone: "error" as const, hint: "Not a valid bech32 address" };
    }
    if (expectedPrefix && prefixOf(value) !== expectedPrefix) {
      return {
        tone: "error" as const,
        hint: `Expected a ${expectedPrefix}1… address`,
      };
    }
    if (chain && value === chain.address) {
      return { tone: "error" as const, hint: "That is this wallet's address" };
    }
    const known = contacts.find((c) => c.address === value);
    return {
      tone: "valid" as const,
      hint: known ? `Saved as ${known.label}` : "Valid address",
    };
  }, [recipient, chain, contacts, expectedPrefix]);

  const amountUnits = toBaseUnits(amount, decimals);
  const overBalance =
    amountUnits !== null && available !== null && amountUnits > available;
  const channelOk = !cross || Boolean(channelCheck?.ok);
  const canReview =
    Boolean(chain) &&
    (!cross || Boolean(destChain)) &&
    recipientState.tone === "valid" &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    channelOk;

  function applyPercent(pct: number) {
    if (available === null) return;
    const units = (available * BigInt(pct)) / 100n;
    setAmount(formatUnitsExact(units.toString(), decimals));
  }

  if (!chain) {
    return (
      <ScreenScaffold title="Send" onBack={onBack}>
        <Callout tone="warning" title="No networks enabled">
          Enable at least one network before sending.
        </Callout>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title="Send"
      onBack={onBack}
      right={
        <span className="font-mono text-[9.5px] text-fg-dim">
          {truncateAddress(chain.address, 6, 4)}
        </span>
      }
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onBack}>
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={!canReview}
            onClick={() => setReview(true)}
          >
            Review
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <Segmented<SendMode>
          size="sm"
          className="w-full"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setReview(false);
            setRecipient("");
          }}
          options={[
            { value: "send", label: "Send" },
            { value: "cross", label: "Cross-send" },
          ]}
        />

        <ChainOverlayPicker
          label={cross ? "From" : "Asset"}
          chain={chain}
          chains={chains}
          balance={balance}
          hidden={hidden}
          onSelect={(id) => {
            setChainId(id);
            setRecipient("");
            setAmount("");
            setChannelId("");
            if (id === destChainId) {
              const other = chains.find((c) => c.chainId !== id);
              if (other) setDestChainId(other.chainId);
            }
          }}
        />

        {cross ? (
          <ChainOverlayPicker
            label="To network"
            chain={destChain}
            chains={chains.filter((c) => c.chainId !== chain.chainId)}
            hidden={hidden}
            onSelect={(id) => {
              setDestChainId(id);
              setRecipient("");
              setChannelId("");
            }}
          />
        ) : null}

        <section>
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
            To
          </p>
          <Input
            className="mt-1.5"
            placeholder={`${expectedPrefix ?? "cosmos"}1…`}
            value={recipient}
            spellCheck={false}
            autoComplete="off"
            state={recipientState.tone}
            hint={recipientState.hint}
            onChange={(e) => setRecipient(e.target.value)}
            trailing={
              <AddressFieldActions
                onScan={() => setPicker("qr")}
                onBook={() => setPicker("book")}
              />
            }
          />
          {contacts.length > 0 && !recipient ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {contacts.slice(0, 4).map((contact) => (
                <li key={contact.id}>
                  <button
                    type="button"
                    onClick={() => setRecipient(contact.address)}
                    className={cn(
                      "rounded-full border border-[var(--z-line)] px-2.5 py-1 text-[10.5px] text-fg-muted",
                      "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                      focusRing,
                    )}
                  >
                    {contact.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Amount
            </p>
            <p className="font-mono text-[9.5px] text-fg-dim">
              {hidden
                ? "••••"
                : balance
                  ? `${formatUnits(balance.available, decimals)} available`
                  : "balance unknown"}
            </p>
          </div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-[28px] font-medium tracking-[-0.04em] text-fg outline-none",
                "placeholder:text-fg-faint",
              )}
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-fg-dim">
              {chain.entry.coinDenom}
            </span>
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {PERCENTS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={available === null}
                onClick={() => applyPercent(pct)}
                className={cn(
                  "flex-1 rounded-full border border-[var(--z-line)] py-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-muted",
                  "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                  "disabled:cursor-not-allowed disabled:opacity-40",
                  focusRing,
                )}
              >
                {pct === 100 ? "MAX" : `${pct}%`}
              </button>
            ))}
          </div>
          {overBalance ? (
            <p className="mt-2 text-[10.5px] text-[var(--z-danger-fg)]">
              More than the available balance.
            </p>
          ) : null}
        </section>

        {cross && destChain ? (
          <ChannelPanel
            sourceChainId={chain.chainId}
            destChainId={destChain.chainId}
            channelId={channelId}
            onChannelId={setChannelId}
            options={channels}
            loading={channelsLoading}
            check={channelCheck}
          />
        ) : null}

        <Input
          label="Memo (optional)"
          placeholder="Visible to everyone on chain"
          value={memo}
          maxLength={256}
          onChange={(e) => setMemo(e.target.value)}
        />

        <section className="flex flex-col gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
          <KeyValueRow label="From" value={chain.entry.chainId} />
          {cross && destChain ? (
            <KeyValueRow label="To" value={destChain.entry.chainId} />
          ) : null}
          <KeyValueRow
            label="Route"
            value={
              cross
                ? `IBC · ${normalizeChannelId(channelId) || "channel ?"}`
                : "Direct · MsgSend"
            }
          />
          <KeyValueRow
            label="Gas price"
            value={`${chain.entry.gasPriceStep?.average ?? 0.025} ${chain.entry.feeMinimalDenom}`}
          />
        </section>

        {review ? (
          <Callout tone="warning" title="Review looks good">
            <span className="block">
              {amount} {chain.entry.coinDenom} to{" "}
              {truncateAddress(recipient, 10, 8)}
              {cross && destChain
                ? ` via ${normalizeChannelId(channelId)} → ${destChain.entry.chainId}`
                : ` on ${chain.entry.chainId}`}
              {memo ? ` · memo "${memo}"` : ""}.
            </span>
            <span className="mt-1.5 block">
              Broadcasting is not wired to a node yet, so nothing has been sent.
              Everything above is validated locally
              {cross ? " and the channel was checked on-chain" : ""}.
            </span>
          </Callout>
        ) : null}

        <p className="flex items-center justify-center gap-1.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          <IconSend width={16} height={16} />
          Signed on this device
        </p>

        {chain.entry.network === "testnet" ? (
          <Pill tone="warning" className="self-start">
            testnet funds
          </Pill>
        ) : null}

        {!balance && cross ? (
          <Callout tone="info" title="Live balances help here">
            Cross-send finds open IBC channels from each chain&rsquo;s public
            endpoint. Turn on live balances if discovery stays empty.
          </Callout>
        ) : null}
      </div>
      {picker === "book" ? (
        <AddressBookPicker
          contacts={contacts}
          expectedPrefix={expectedPrefix}
          onClose={() => setPicker(null)}
          onPick={(address) => {
            setRecipient(address);
            setPicker(null);
          }}
        />
      ) : null}
      {picker === "qr" ? (
        <QrScanOverlay
          onClose={() => setPicker(null)}
          onScan={(address) => {
            setRecipient(address);
            setPicker(null);
          }}
        />
      ) : null}
    </ScreenScaffold>
  );
}
