export const STORAGE_KEYS = {
  /** Sealed keyring envelope in chrome.storage.local only. */
  envelope: "zunia.envelope",
  /**
   * Extra sealed envelopes, one per added account that has its own mnemonic.
   * Keyed by account index. The first wallet stays in `envelope`.
   */
  accountEnvelopes: "zunia.accountEnvelopes",
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
  /**
   * Legacy global network list. New writes live on each account
   * (`AccountInfo.enabledChainIds`). Kept as a one-time migration seed.
   */
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
  /**
   * Unbonding and governance rows the worker's slow pass last read, with the
   * time it read them (`lib/realtime.ts`), so the feed keeps them between passes.
   */
  noticeContext: "zunia.noticeContext",
  /**
   * The claimable-rewards notice: its cycle, phase and the claimable amounts
   * the last look saw per chain (`lib/notices.ts`). One notice per cycle, never
   * one per block.
   */
  rewardsNotice: "zunia.rewardsNotice",
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
   * Proven IBC traces for vouchers the token table does not list, in
   * chrome.storage.local (`lib/token-identity.ts`). Facts only (origin chain,
   * base denom, path), never labels, so a naming-rule change needs no wipe.
   * Versioned; a record from another version is ignored.
   */
  tokenIdentity: "zunia.tokenIdentity",
  /**
   * The Osmosis crosschain-swaps router's route table, cached in
   * chrome.storage.session for about an hour (`lib/xcs-routes.ts`).
   */
  xcsRoutes: "zunia.xcsRoutes",
  /**
   * The pool swap a user set out to make before moving its tokens to Osmosis
   * (`lib/swap-intent.ts`), in chrome.storage.session for an hour, so Swap
   * opens on it once they arrive.
   */
  swapIntent: "zunia.swapIntent",
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
  /** Unlocked mnemonic of the active account ONLY in chrome.storage.session. */
  sessionMnemonic: "zunia.session.mnemonic",
  /** All unlocked phrases, keyed by seed id (`primary` or account index). */
  sessionMnemonics: "zunia.session.mnemonics",
  /** Password kept only while unlocked, so an add-account can seal a new seed. */
  sessionPassword: "zunia.session.password",
  sessionUnlockedAt: "zunia.session.unlockedAt",
  sessionActiveAccount: "zunia.session.activeAccount",
  /** Tab id to the origin of the page that made provider calls in it. */
  providerTabs: "zunia.session.providerTabs",
  /** Recent wallet events for Safari's event ports, see lib/event-port.ts. */
  providerEventLog: "zunia.session.providerEventLog",
} as const;
