import type { ActivityItem, ValidatorInfo } from "../../lib/chain-queries";

/** Every view the popup can show. */
export type PopupRoute =
  | "boot"
  | "welcome"
  | "create"
  | "import"
  | "unlock"
  | "forgot-password"
  // Tab roots
  | "home"
  | "earn"
  | "swap"
  | "activity"
  // Pushed views
  | "chain"
  | "tx"
  | "validator"
  | "send"
  | "receive"
  | "networks"
  | "add-chain"
  // Old name for sending to another chain; never stored, see `pushLocation`.
  | "bridge"
  | "nft"
  | "nft-token"
  | "governance"
  | "notifications"
  | "address-book"
  | "settings"
  | "security"
  | "preferences"
  | "wallets"
  | "reveal"
  | "sites"
  | "approve";

/** Routes that render the bottom tab bar, in tab order. */
export const TAB_ROUTES = ["home", "earn", "swap", "activity"] as const;
export type TabRoute = (typeof TAB_ROUTES)[number];

export function isTabRoute(route: PopupRoute): route is TabRoute {
  return (TAB_ROUTES as readonly string[]).includes(route);
}

export interface PopupLocation {
  route: PopupRoute;
  /** Set for chain-scoped views (chain detail, send, receive). */
  chainId?: string;
  /** Tx hash for the transaction detail route. */
  hash?: string;
  /** The row the transaction detail was opened from. */
  tx?: ActivityItem;
  /** Validator operator address for the validator detail route. */
  operatorAddress?: string;
  /** The validator the detail was opened from. */
  validator?: ValidatorInfo;
  /** CW721 contract address for the NFT token detail route. */
  collectionAddress?: string;
  /** CW721 token id for the NFT token detail route. */
  tokenId?: string;
  /** Opens Send on its other-chain mode. */
  sendMode?: "cross";
}

/** Deep enough for any real path through the popup; older entries drop off. */
export const MAX_HISTORY = 24;

export function sameLocation(a: PopupLocation, b: PopupLocation): boolean {
  return (
    a.route === b.route &&
    a.chainId === b.chainId &&
    a.hash === b.hash &&
    a.operatorAddress === b.operatorAddress &&
    a.collectionAddress === b.collectionAddress &&
    a.tokenId === b.tokenId &&
    a.sendMode === b.sendMode
  );
}

/** Retired views resolve to the screen that replaced them. */
function canonical(next: PopupLocation): PopupLocation {
  if (next.route !== "bridge") return next;
  return next.chainId
    ? { route: "send", chainId: next.chainId, sendMode: "cross" }
    : { route: "send", sendMode: "cross" };
}

/**
 * The history after navigating to `next`. A tab root starts a fresh history,
 * as the bottom bar does; any other view is pushed, unless it is already the
 * current one.
 */
export function pushLocation(
  stack: readonly PopupLocation[],
  target: PopupLocation,
): PopupLocation[] {
  const next = canonical(target);
  if (isTabRoute(next.route)) return next.route === "home" && !next.chainId ? [] : [next];
  const top = stack[stack.length - 1];
  if (top && sameLocation(top, next)) return [...stack];
  return [...stack, next].slice(-MAX_HISTORY);
}
