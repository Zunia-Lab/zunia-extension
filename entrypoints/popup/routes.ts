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
  | "asset"
  | "validator"
  | "send"
  | "receive"
  | "networks"
  | "add-chain"
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
  /** Validator operator address for the validator detail route. */
  operatorAddress?: string;
  /** CW721 contract address for the NFT token detail route. */
  collectionAddress?: string;
  /** CW721 token id for the NFT token detail route. */
  tokenId?: string;
}

/** Where the back button goes from each pushed view. */
export const PARENT_ROUTE: Partial<Record<PopupRoute, PopupRoute>> = {
  chain: "home",
  tx: "activity",
  asset: "home",
  validator: "earn",
  send: "home",
  receive: "home",
  networks: "home",
  "add-chain": "networks",
  bridge: "home",
  // NFTs sit beside Bridge and Governance: a top-level destination that is not
  // a daily one. Same place it takes in the dashboard's main nav and in
  // mobile's drawer, so the three products stay one product.
  nft: "home",
  "nft-token": "nft",
  governance: "home",
  notifications: "home",
  "address-book": "settings",
  settings: "home",
  security: "settings",
  preferences: "settings",
  wallets: "settings",
  reveal: "security",
  sites: "security",
};
