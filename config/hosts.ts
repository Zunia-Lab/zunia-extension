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
  "https://backend.zuniawallet.com/*",
  "https://api.zuniawallet.com/*",
  "https://indexer.zuniawallet.com/*",
] as const;

/**
 * Requested at runtime, never at install time. Reading balances from a public
 * chain REST endpoint means talking to whichever host the registry lists, so
 * the user opts in from Settings → Live balances and can revoke at any time.
 */
export const OPTIONAL_HOST_PERMISSIONS = ["https://*/*"] as const;

/** Pages that may load the injected MAIN-world provider script. */
export const PROVIDER_RESOURCE_MATCHES = [
  "https://*/*",
  "http://localhost/*",
  "http://127.0.0.1/*",
  "http://[::1]/*",
] as const;
