export const STORAGE_KEYS = {
  /** Sealed keyring envelope in chrome.storage.local only. */
  envelope: "zunia.envelope",
  /** Account metadata (no secrets) in chrome.storage.local. */
  accounts: "zunia.accounts",
  /** Per-origin / per-chain grants. */
  permissions: "zunia.permissions",
  /** Known recipients for first-time warnings. */
  knownRecipients: "zunia.knownRecipients",
  /** User settings (keplr alias, blind signing, lock timeout). */
  settings: "zunia.settings",
  /** Suggested / custom chains. */
  suggestedChains: "zunia.suggestedChains",
  /** Chains enabled in the wallet UI after onboarding. */
  enabledChains: "zunia.enabledChains",
  /** Short-lived cache of REST balance reads. */
  balanceCache: "zunia.balanceCache",
  /** Short-lived cache of spot price reads. */
  priceCache: "zunia.priceCache",
  /** Saved recipients for the send flow. */
  addressBook: "zunia.addressBook",
  /** Ids of notifications the user has already seen. */
  readNotifications: "zunia.readNotifications",
  /**
   * Notice ids already announced as a browser alert, plus whether the feed has
   * ever been seeded. See `lib/notices.ts`: the seeded flag is what stops a
   * first open from firing one alert per pre-existing notice, without also
   * swallowing the first real one after the list is trimmed.
   */
  announcedNotices: "zunia.announcedNotices",
  /** Arrivals a live socket reported, kept until history catches up. */
  recentArrivals: "zunia.recentArrivals",
  /** Networks the user added by hand. */
  customChains: "zunia.customChains",
  /** Cache of IBC transfer channels the engine discovered or the user entered. */
  channelRoutes: "zunia.channelRoutes",
  /** Crosschain-swap contract address override, when the user set one. */
  swapContract: "zunia.swapContract",
  /** Signed routes still in flight, so tracking survives a popup close. */
  pendingTransfers: "zunia.pendingTransfers",
  /** Routes the background already announced, so each ends in one notification. */
  notifiedTransfers: "zunia.notifiedTransfers",
  /** Osmosis's listed token list, cached in chrome.storage.session. */
  osmosisAssets: "zunia.osmosisAssets",
  /**
   * CW721 contract addresses the user added, keyed by chain id.
   *
   * CosmWasm has no chain-level "tokens by owner" index, so without an address
   * there is nothing to query. This list is the discovery path that always
   * works, and the only one that is populated in a stock install.
   */
  nftContracts: "zunia.nftContracts",
  /** cw-ics721 bridge addresses the user pinned, keyed by chain id. */
  nftBridges: "zunia.nftBridges",
  /**
   * What the CW721 code scan learned about each chain's wasm codes.
   *
   * Two halves with two lifetimes. The verdict "code 42 answers the cw721
   * `tokens` query" is permanent: wasm code is immutable once uploaded, so the
   * interface of a code id never changes and the answer never has to be asked
   * twice. The list of contract addresses instantiated from those codes does
   * grow, so it carries a timestamp and is refreshed on a TTL or when the user
   * hits reload. Without this cache the screen re-probes every wasm code on
   * every open, which is around ninety requests per chain.
   */
  nftWasmScan: "zunia.nftWasmScan",
  /** Consecutive wrong passwords and when the next attempt is allowed. No secrets. */
  passwordThrottle: "zunia.passwordThrottle",
  /** Favorite and recent picks per picker kind (chain, token, contact ids). */
  pickerMemory: "zunia.pickerMemory",
  /** Unlocked mnemonic ONLY in chrome.storage.session. */
  sessionMnemonic: "zunia.session.mnemonic",
  sessionUnlockedAt: "zunia.session.unlockedAt",
  sessionActiveAccount: "zunia.session.activeAccount",
  /** Tab id to the origin of the page that made provider calls in it. */
  providerTabs: "zunia.session.providerTabs",
  /** Recent wallet events for Safari's event ports, see lib/event-port.ts. */
  providerEventLog: "zunia.session.providerEventLog",
} as const;
