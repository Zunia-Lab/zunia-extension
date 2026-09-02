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
  | "send"
  | "receive"
  | "networks"
  | "add-chain"
  | "bridge"
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
}

/** Where the back button goes from each pushed view. */
export const PARENT_ROUTE: Partial<Record<PopupRoute, PopupRoute>> = {
  chain: "home",
  send: "home",
  receive: "home",
  networks: "home",
  "add-chain": "networks",
  bridge: "home",
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
