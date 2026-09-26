/**
 * Narrow extension host_permissions for store review.
 *
 * dApp pages do not need host_permissions: the content script injects the
 * provider, and CosmJS/RPC traffic runs in the page (or via user-granted /
 * externally_connectable origins). These hosts are only for extension-owned
 * backend / indexer fetches from the background or popup.
 */
export const HOST_PERMISSIONS = [
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
  "https://backend.zunialab.com/*",
  "https://api.zunialab.com/*",
  "https://indexer.zunialab.com/*",
] as const;

/**
 * Requested at runtime, never at install time. Reading balances from a public
 * chain REST endpoint means talking to whichever host the registry lists, so
 * the user opts in from Settings → Live balances and can revoke at any time.
 */
export const OPTIONAL_HOST_PERMISSIONS = ["https://*/*"] as const;

/**
 * Websocket origins, for the realtime chain subscriptions.
 *
 * Separate from {@link OPTIONAL_HOST_PERMISSIONS} for two reasons, both of
 * which bite if they are merged:
 *
 * 1. An https wildcard does not cover the websocket schemes. Chrome match
 *    patterns match on the scheme, so an extension holding the https wildcard
 *    is still refused a `wss` connection. These have to be asked for by name or
 *    every socket fails at the handshake, which looks exactly like "the chain
 *    is quiet" rather than like a permission problem.
 * 2. They have to be grantable separately. Reads are gated on the https origins
 *    alone. Folding the websocket schemes into that set would make
 *    `permissions.contains` return false for every user who granted live
 *    balances before realtime existed, and they would lose balances entirely
 *    rather than lose realtime, which is the smaller thing to lose.
 *
 * Both sets are requested together when the user turns live balances on, so a
 * new install sees one prompt. A user who ends up with only the https half
 * keeps working balances and falls back to the one-minute poll.
 *
 * `ws` is here for a local development node; `wss` is every public RPC. Neither
 * may appear in `host_permissions`: the Chrome Web Store refuses a websocket
 * scheme there and accepts it only as an optional permission requested at
 * runtime.
 */
export const REALTIME_HOST_PERMISSIONS = ["wss://*/*", "ws://*/*"] as const;

/** Pages that may load the injected MAIN-world provider script. */
export const PROVIDER_RESOURCE_MATCHES = [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
] as const;
