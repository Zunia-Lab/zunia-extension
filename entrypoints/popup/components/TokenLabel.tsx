/**
 * Shared token presentation. Every screen draws a token from its
 * {@link TokenIdentity} here, so the logo, the ticker and the words for where
 * it sits read the same everywhere, and no screen builds token text itself.
 *
 * - {@link TokenAvatar}: the token's own logo or a monogram, a badge for the
 *   chain it sits on, and a seal only when the identity is proven.
 * - {@link TokenLabel}: the ticker and the identity's subtitle, as a row or inline.
 * - {@link TokenPill}: the two-line picker trigger, the ticker and then "on X".
 * - {@link tokenPickerItem}: one PickerSheet row.
 *
 * The ticker's suffix is what tells variants apart (USDC.n, USDC.axl.polygon,
 * USDC.n·3F5B for an impostor), so it is never cut: where space runs out the
 * family part gives way first, and the full text is in the tooltip.
 */

import type { ComponentPropsWithRef } from "react";
import { Pill, TokenLogo, cn, focusRing } from "@zunialab/ui";

import { catalogIconFor, findCatalogEntry } from "../../../lib/chain-catalog";
import { formatTokenAmount } from "../../../lib/token-amount";
import {
  UNLISTED_TOKEN,
  isUnlistedLocal,
  isUserAddedChain,
  shortDenom,
  tokenKeywords,
  tokenText,
  type TokenIdentity,
} from "../../../lib/token-identity";
import { IconChevronDown } from "../screens/icons";
import type { PickerItem } from "./PickerSheet";

/* -------------------------------------------------------------------------- *
 * Words
 * -------------------------------------------------------------------------- */

/**
 * How the place a token sits is worded: `on Osmosis` for a balance, `Delivered
 * on Osmosis` for a swap or transfer destination, `Held on Osmosis` for the
 * side being spent.
 */
export type TokenLocation = "on" | "delivered" | "held";

/**
 * The ticker split where it may be cut: `head` is the family part, which
 * gives way first; `tail` names the variant and is never cut. `USDC.axl.polygon`
 * is `USDC` + `.axl.polygon`; a ticker that is not family + suffix splits at
 * its first `.` or `·` (`STARS` + `.legacy`); one without either is all head.
 */
export function tickerParts(identity: Pick<TokenIdentity, "ticker" | "family">): {
  head: string;
  tail: string;
} {
  const { ticker, family } = identity;
  if (family && ticker.length > family.length && ticker.startsWith(family)) {
    const tail = ticker.slice(family.length);
    if (/^[.·]/.test(tail)) return { head: family, tail };
  }
  const at = ticker.search(/[.·]/);
  return at > 0 ? { head: ticker.slice(0, at), tail: ticker.slice(at) } : { head: ticker, tail: "" };
}

/**
 * The tag for a token held where nothing is issued for real: `Testnet` on a
 * registry testnet, `Custom` on a chain the user added. Null on a registry
 * mainnet. A user-added chain is stored with `network: "testnet"` whatever it
 * is (lib/custom-chains.ts), so the user's own list decides, not that field.
 */
export function networkTag(
  identity: Pick<TokenIdentity, "testnet" | "heldOnChainId">,
): "Testnet" | "Custom" | null {
  if (!identity.testnet) return null;
  return isUserAddedChain(identity.heldOnChainId) ? "Custom" : "Testnet";
}

/** `on Osmosis`, `Delivered on Osmosis` or `Held on Osmosis`. */
export function tokenLocationText(identity: TokenIdentity, location: TokenLocation = "on"): string {
  if (location === "on") return tokenText(identity, "pill");
  return `${location === "delivered" ? "Delivered" : "Held"} on ${identity.heldOnChainName}`;
}

/**
 * A row's subtitle. `on` is the identity's own row text (`Noble USDC · on
 * Osmosis`, `Native on Injective`); the other wordings name the token and say
 * where it goes (`Injective USDC · delivered on Injective`). An unknown token
 * keeps its short denom, the only thing that identifies it, and a local token
 * nothing lists says so (`Unlisted token · held on Osmosis`).
 */
export function tokenSubtitle(identity: TokenIdentity, location: TokenLocation = "on"): string {
  if (location === "on") return tokenText(identity, "row");
  const where = `${location} on ${identity.heldOnChainName}`;
  if (identity.provenance === "unknown") {
    return `Unknown origin · ${where} · ${shortDenom(identity.denom)}`;
  }
  if (isUnlistedLocal(identity)) return `${UNLISTED_TOKEN} · ${where}`;
  return `${identity.name} · ${where}`;
}

/**
 * {@link tokenSubtitle} in the two pieces a row lays out: `lead` may be cut
 * at its end, `tail` never is. The tail is an unknown token's short denom
 * (`ibc/0123…ABCDEF`), the one thing that tells two unknown tokens apart, so
 * a row moves it to a line of its own rather than lose its hash; `null` for
 * every other token. `${lead} · ${tail}` is the subtitle.
 */
export function subtitleParts(
  identity: TokenIdentity,
  location: TokenLocation = "on",
): { lead: string; tail: string | null } {
  const text = tokenSubtitle(identity, location);
  if (identity.provenance !== "unknown") return { lead: text, tail: null };
  const tail = shortDenom(identity.denom);
  return text.endsWith(` · ${tail}`)
    ? { lead: text.slice(0, -(tail.length + 3)), tail }
    : { lead: text, tail: null };
}

/** A tooltip's full text: `USDC.axl.polygon · Axelar USDC from Polygon · on Osmosis`. */
export function tokenTooltip(identity: TokenIdentity, location: TokenLocation = "on"): string {
  return `${identity.ticker} · ${tokenSubtitle(identity, location)}`;
}

/**
 * The accessible name: the ticker as shown, then origin and location in
 * words. `USDC.inj, USDC from Injective, on Osmosis`; `USDC.inj, USDC from
 * Injective, delivered on Injective`; `USDC.inj, native on Injective`.
 *
 * The ticker leads because it is the visible label, which a voice user says
 * to pick the control (WCAG 2.5.3), and because it is the one part that never
 * repeats on a chain: the words can (DGN and its guard-renamed DGN·CD64 are
 * both "DGN from Dungeon"). The words carry what a spelled-out "USDC dot inj"
 * does not. A bridged token that names its source network reads by its full
 * name (`Axelar USDC from Polygon`), at every location, since "USDC from
 * Axelar" fits USDC.axl, USDC.axl.polygon and USDC.axl.avax alike, on Osmosis
 * and delivered on Axelar. A testnet or user-added chain says so when its
 * name does not. A token nothing lists says that, wherever it sits, and is
 * never "native" (`USDC.n·EE7A, unlisted token, held on Osmosis`).
 */
export function tokenA11yName(identity: TokenIdentity, location: TokenLocation = "on"): string {
  const where = location === "on" ? `on ${identity.heldOnChainName}` : `${location} on ${identity.heldOnChainName}`;
  const home = identity.originChainId === identity.heldOnChainId;
  let words: string;
  if (identity.provenance === "unknown") {
    words = `Unknown token ${shortDenom(identity.denom)}, ${where}`;
  } else if (isUnlistedLocal(identity)) {
    words = `${UNLISTED_TOKEN.toLowerCase()}, ${where}`;
  } else if (!identity.listed) {
    // A walked voucher nothing names: `Unlisted Neutron token, on Osmosis`.
    words = `${identity.name}, ${where}`;
  } else if (location === "on" && home) {
    words = tokenText(identity, "a11y");
  } else if (identity.alloyed || identity.sourceNetwork !== null) {
    words = `${identity.name}, ${where}`;
  } else {
    words = `${identity.family} from ${identity.originChainName ?? "an unknown chain"}, ${where}`;
  }
  // Words that already say the ticker whole (`USDC.inj, native on Injective`,
  // an unknown erc20 named by its short denom) are not prefixed twice.
  const { ticker } = identity;
  const said = !ticker || ` ${words.replace(/,/g, " ")} `.includes(` ${ticker} `);
  let name = said ? words : `${ticker}, ${words}`;
  const tag = networkTag(identity);
  if (tag && !name.toLowerCase().includes(tag.toLowerCase())) {
    name += tag === "Testnet" ? ", testnet" : ", custom chain";
  }
  return name;
}

/**
 * The seal's words: how the identity was proven, or null when it was not.
 * Never derived from the holding chain being in a registry; only `proven`
 * (the registry, the hash-verified table or a canonical channel walk) counts.
 */
export function provenanceLabel(
  identity: Pick<TokenIdentity, "proven" | "provenance" | "originChainName" | "heldOnChainName">,
): string | null {
  if (!identity.proven) return null;
  switch (identity.provenance) {
    case "native":
      return `Verified: issued on ${identity.originChainName ?? identity.heldOnChainName}`;
    case "catalog":
      return "Verified: listed in the chain registry";
    case "table":
      return "Verified: IBC path matches the registry";
    case "channel-walk":
      return `Verified: IBC path traced to ${identity.originChainName ?? "its origin"}`;
    case "unknown":
      return null;
  }
}

/**
 * Whether the avatar badges the chain the token sits on.
 * - `auto`: when the token is away from its origin, or its origin is unknown.
 * - `always`: Swap and Send rows, where every row names its chain.
 * - `never`: rows already grouped under their chain.
 */
export type LocationBadge = "auto" | "always" | "never";

export function showsLocationBadge(
  identity: Pick<TokenIdentity, "originChainId" | "heldOnChainId">,
  badge: LocationBadge = "auto",
): boolean {
  if (badge !== "auto") return badge === "always";
  return identity.originChainId !== identity.heldOnChainId;
}

/* -------------------------------------------------------------------------- *
 * Avatar
 * -------------------------------------------------------------------------- */

/**
 * The proven seal in the top-right corner, for when the location badge takes
 * the corner TokenLogo keeps for its own seal. Same mark and theme tokens as
 * the design system's seal, so both read the same in light and dark.
 */
function CornerSeal({ size }: { size: number }) {
  return (
    <span
      className="pointer-events-none absolute right-0 top-0 overflow-hidden rounded-full leading-none"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 24 24" className="block size-full" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="var(--z-button)"
          stroke="var(--z-surface)"
          strokeWidth="1.75"
        />
        <path
          d="M7.6 12.3 L10.6 15.2 L16.4 8.8"
          fill="none"
          stroke="var(--z-button-fg)"
          strokeWidth="2.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/**
 * The token's logo, never a chain's: `logoUrl` is a token logo by contract,
 * and without one TokenLogo draws a monogram (`?` when the token is unknown).
 * The location chain sits in the badge; the seal shows only for a proven
 * identity, with its provenance as the tooltip.
 *
 * Decorative by default: the ticker and subtitle beside it already name the
 * token and its chain. Give `label` when the avatar stands alone.
 */
export function TokenAvatar({
  identity,
  size = 32,
  locationBadge = "auto",
  label,
  className,
}: {
  identity: TokenIdentity;
  size?: number;
  locationBadge?: LocationBadge;
  /** Accessible name; without it the avatar is hidden from assistive tech. */
  label?: string;
  className?: string;
}) {
  const badge = showsLocationBadge(identity, locationBadge);
  const chain = badge ? findCatalogEntry(identity.heldOnChainId) : undefined;
  const seal = provenanceLabel(identity);
  const sealSize = Math.min(13, Math.max(9, Math.round(size * 0.38)));
  return (
    <span
      className={cn("relative inline-flex shrink-0 leading-none", className)}
      style={{ width: size, height: size }}
      title={seal ?? undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <TokenLogo
        src={identity.logoUrl ?? undefined}
        symbol={identity.provenance === "unknown" ? "?" : identity.ticker}
        size={size}
        verified={seal !== null && !badge}
        verifiedLabel={seal ?? undefined}
        chainSrc={chain ? catalogIconFor(chain) : undefined}
        chainLabel={badge ? identity.heldOnChainName : undefined}
      />
      {seal && badge ? <CornerSeal size={sealSize} /> : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Text
 * -------------------------------------------------------------------------- */

/**
 * The ticker on one line. The family part truncates first; the suffix does
 * not shrink. Only a suffix longer than the whole line (free text someone
 * minted) is cut, from its start, so its `·hash` mark stays in view.
 *
 * The two parts are separate boxes, which assistive tech reads as two words
 * (`USDC .n`), so they are drawn for the eye only and the ticker is said
 * whole from a visually hidden copy. That copy is not selectable, so copying
 * the row still gives the ticker once.
 *
 * Exported for any surface that shows a ticker alone, a picker label
 * included: a plain `truncate` cuts the end, which is where the mark is.
 */
export function TokenTicker({
  identity,
  className,
}: {
  identity: Pick<TokenIdentity, "ticker" | "family">;
  className?: string;
}) {
  const { head, tail } = tickerParts(identity);
  return (
    <span className={cn("flex min-w-0 whitespace-nowrap", className)}>
      <span aria-hidden="true" className="min-w-0 truncate">
        {head}
      </span>
      {tail ? (
        <span aria-hidden="true" dir="rtl" className="max-w-full shrink-0 overflow-hidden text-ellipsis">
          <bdi dir="ltr">{tail}</bdi>
        </span>
      ) : null}
      <span className="sr-only select-none">{identity.ticker}</span>
    </span>
  );
}

function NetworkTagPill({ tag }: { tag: string }) {
  return (
    <Pill
      tone="warning"
      className="shrink-0 gap-0 px-1.5 py-px text-[8px] leading-[1.4] tracking-[0.08em]"
    >
      {tag}
    </Pill>
  );
}

/**
 * The ticker with the identity's subtitle, and a Testnet (or Custom) tag when
 * the token sits on a testnet or a chain the user added.
 * - `row`: two lines, `USDC.n` over `Noble USDC · on Osmosis`. An unknown
 *   token's short denom is never cut: when the line cannot hold it whole it
 *   moves under the rest (`Unknown origin · on Osmosis ·` over
 *   `ibc/0123…ABCDEF`), and only the words before it may be cut, at their
 *   end, when they alone are wider than the row.
 * - `inline`: one line, the subtitle muted after the ticker; it truncates
 *   before the ticker does, and a ticker wider than the line (free text
 *   someone minted) truncates by the ticker rule instead of spilling out.
 */
export function TokenLabel({
  identity,
  variant = "row",
  location = "on",
  dense = false,
  className,
}: {
  identity: TokenIdentity;
  variant?: "row" | "inline";
  location?: TokenLocation;
  /** Smaller ticker, for grouped rows and sheets. */
  dense?: boolean;
  className?: string;
}) {
  const subtitle = tokenSubtitle(identity, location);
  const tag = networkTag(identity);
  const tickerClass = cn(
    "font-semibold tracking-[-0.02em] text-fg",
    dense ? "text-[12.5px]" : "text-[13px]",
  );

  if (variant === "inline") {
    return (
      <span className={cn("flex min-w-0 max-w-full items-center gap-1.5", className)}>
        <TokenTicker identity={identity} className={cn(tickerClass, "max-w-full shrink-0")} />
        {tag ? <NetworkTagPill tag={tag} /> : null}
        <span className="min-w-0 truncate text-[11px] text-fg-muted" title={subtitle}>
          {subtitle}
        </span>
      </span>
    );
  }

  const { lead, tail } = subtitleParts(identity, location);
  return (
    <span className={cn("block min-w-0", className)}>
      <span className="flex min-w-0 items-center gap-1.5">
        <TokenTicker identity={identity} className={tickerClass} />
        {tag ? <NetworkTagPill tag={tag} /> : null}
      </span>
      {tail ? (
        <span
          className="mt-0.5 flex min-w-0 flex-wrap gap-x-1 text-[11px] text-fg-muted"
          title={subtitle}
        >
          <span className="min-w-0 max-w-full truncate">{lead} ·</span>
          <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{tail}</span>
        </span>
      ) : (
        <span className="mt-0.5 block truncate text-[11px] text-fg-muted" title={subtitle}>
          {subtitle}
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Pill
 * -------------------------------------------------------------------------- */

/**
 * The token a Swap or Send side uses, as a two-line button: the ticker, then
 * `on Osmosis` (or `Delivered on Osmosis`). It grows with its text up to
 * 168px, Send's existing cap, which leaves a 110px text column: the long
 * registry tickers (USDC.axl.polygon is 103px at this size) and `Delivered on
 * Injective` fit whole at popup width, and the amount beside it keeps 122px.
 * A longer ticker gives up its family part first, never the suffix. The
 * tooltip has the full text; the accessible name is the ticker, then origin
 * and location in words ({@link tokenA11yName}).
 *
 * The location stays on one line and a long chain name is cut at its end, so
 * its start stays readable (`on Warden Protocol…`); the tooltip and the
 * accessible name carry the whole name, and so do the Swap cards' footers
 * and Send's network picker. Two lines would make the pill taller for a
 * handful of chains only, so the Swap cards and the Send row would change
 * height with the token picked.
 *
 * The second line names the chain, so the 22px logo carries no location
 * badge by default and the seal keeps its usual corner; a badge and a seal
 * together would cover most of a logo that small.
 *
 * `labelPrefix` names the side for assistive tech (`From asset: USDC.inj,
 * USDC from Injective, on Osmosis`); an explicit `aria-label` replaces the
 * whole name.
 */
export function TokenPill({
  identity,
  location = "on",
  emptyLabel = "Choose",
  labelPrefix,
  locationBadge = "never",
  chevron = true,
  className,
  ...button
}: Omit<ComponentPropsWithRef<"button">, "children"> & {
  identity: TokenIdentity | undefined;
  location?: TokenLocation;
  /** Shown in place of the ticker when there is no token. */
  emptyLabel?: string;
  labelPrefix?: string;
  /** The logo's chain badge; off by default, see above. */
  locationBadge?: LocationBadge;
  /** The chevron that says the pill opens a picker. */
  chevron?: boolean;
}) {
  const name = identity ? tokenA11yName(identity, location) : emptyLabel;
  return (
    <button
      type="button"
      aria-label={labelPrefix ? `${labelPrefix}: ${name}` : name}
      title={identity ? tokenTooltip(identity, location) : undefined}
      {...button}
      className={cn(
        "flex min-w-0 max-w-[168px] shrink-0 items-center gap-1.5 rounded-full border border-[var(--z-line)] bg-[var(--z-glass)] py-1 pl-1 pr-2 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
        className,
      )}
    >
      {identity ? (
        <TokenAvatar identity={identity} size={22} locationBadge={locationBadge} />
      ) : (
        <span aria-hidden="true" className="inline-flex shrink-0">
          <TokenLogo symbol="?" size={22} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
        {identity ? (
          <TokenTicker
            identity={identity}
            className="text-[12.5px] font-semibold leading-none tracking-tight text-fg"
          />
        ) : (
          <span className="truncate text-[12.5px] font-semibold leading-none tracking-tight text-fg">
            {emptyLabel}
          </span>
        )}
        {identity ? (
          <span className="truncate text-[10px] leading-none text-fg-dim">
            {tokenLocationText(identity, location)}
          </span>
        ) : null}
      </span>
      {chevron ? (
        <IconChevronDown width={10} height={10} className="shrink-0 text-fg-dim" />
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- *
 * Picker rows
 * -------------------------------------------------------------------------- */

/** A PickerSheet row; `searchOnly` rows appear only in search results (lib/picker.ts). */
export type TokenPickerItem = PickerItem & { searchOnly?: boolean };

export interface TokenPickerItemOptions {
  /** Balance in base units, shown on the right when it is a non-zero integer. */
  readonly amount?: string | bigint | null;
  /** The user hides balances. */
  readonly hidden?: boolean;
  /**
   * Why the row cannot be picked. Set, the row is disabled, and PickerSheet
   * shows the reason as given on its own line under the subtitle, which keeps
   * the location (USDC.inj on Injective and on Osmosis share one reason), so
   * the reason carries no `On Osmosis ·` of its own.
   */
  readonly disabledReason?: string | null;
  /** List the row only in search results, never in Favorites, Recent or All. */
  readonly searchOnly?: boolean;
  /** Badge the location chain on every row (Swap and Send), not only away from the origin. */
  readonly locationChain?: boolean;
}

/** A balance worth a column: a non-zero integer. Anything else shows nothing rather than a made-up 0. */
function hasBalance(amount: string | bigint | null | undefined): amount is string | bigint {
  if (amount === undefined || amount === null) return false;
  if (typeof amount === "bigint") return amount !== 0n;
  const text = amount.trim();
  return /^-?\d+$/.test(text) && /[1-9]/.test(text);
}

/**
 * The widest a picker row's balance may be. 19 digits fit on one line (the
 * `5000000000000000000` of allSHIB in base units); a longer figure and the
 * `base units` words wrap under it, so the label column keeps its room and
 * the ticker is never squeezed to `I…`.
 */
const BALANCE_COLUMN = "max-w-[112px]";

/**
 * One picker row for `identity`: the ticker, the identity's subtitle
 * (`Injective USDC · on Osmosis`, `Native on Injective`), the token logo with
 * its chain badge, and every word a search should match (aliases such as
 * `USDC.noble`, the origin and location chains, the exact denoms). The id is
 * the identity key, `${chainId}:${denom}`, the same id picker memory keeps.
 *
 * The label is drawn by {@link TokenTicker} (`labelNode`), so the suffix and
 * any `·hash` stay in view and assistive tech hears the ticker as one word;
 * `label` stays the text a search matches. The proven seal, which the logo
 * only shows, is said as `srNote`. The balance wraps inside its own column.
 */
export function tokenPickerItem(
  identity: TokenIdentity,
  options: TokenPickerItemOptions = {},
): TokenPickerItem {
  const { amount, hidden = false, disabledReason, searchOnly = false, locationChain = false } = options;
  const tag = networkTag(identity);
  const subtitle = tokenText(identity, "row");
  const seal = provenanceLabel(identity);
  const item: TokenPickerItem = {
    id: identity.key,
    label: identity.ticker,
    labelNode: <TokenTicker identity={identity} />,
    sublabel:
      tag && !subtitle.toLowerCase().includes(tag.toLowerCase())
        ? `${subtitle} · ${tag === "Custom" ? "Custom chain" : tag}`
        : subtitle,
    keywords: tag ? [...tokenKeywords(identity), tag] : tokenKeywords(identity),
    icon: (
      <TokenAvatar
        identity={identity}
        size={24}
        locationBadge={locationChain ? "always" : "auto"}
      />
    ),
    trailing: hasBalance(amount) ? (
      <span
        className={cn(
          "block font-mono text-[9.5px] leading-snug tabular-nums text-fg-dim [overflow-wrap:anywhere]",
          BALANCE_COLUMN,
        )}
      >
        {formatTokenAmount(amount, identity, "picker", { hidden })}
      </span>
    ) : null,
  };
  if (seal) item.srNote = seal;
  if (disabledReason) {
    item.disabled = true;
    item.disabledReason = disabledReason;
  }
  if (searchOnly) item.searchOnly = true;
  return item;
}
