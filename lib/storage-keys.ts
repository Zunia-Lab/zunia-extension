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
  /** Networks the user added by hand. */
  customChains: "zunia.customChains",
  /** Cache of IBC transfer channels the engine discovered or the user entered. */
  channelRoutes: "zunia.channelRoutes",
  /** Crosschain-swap contract address override, when the user set one. */
  swapContract: "zunia.swapContract",
  /** Signed routes still in flight, so tracking survives a popup close. */
  pendingTransfers: "zunia.pendingTransfers",
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
  /** Unlocked mnemonic ONLY in chrome.storage.session. */
  sessionMnemonic: "zunia.session.mnemonic",
  sessionUnlockedAt: "zunia.session.unlockedAt",
  sessionActiveAccount: "zunia.session.activeAccount",
} as const;
