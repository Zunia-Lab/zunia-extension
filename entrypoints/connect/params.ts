import { CONNECT_PARAM } from "../../lib/connect-overlay";

/**
 * The content script builds this URL, so the values are extension-authored,
 * not page-authored. They are still treated as untrusted display data: the
 * approval itself is re-read from the background by id.
 */
const params = new URLSearchParams(window.location.search);

export const APPROVAL_ID = params.get(CONNECT_PARAM.approvalId) ?? "";

/** Origin of the embedding page, used as the postMessage target. */
export const PARENT_ORIGIN = params.get(CONNECT_PARAM.parentOrigin) ?? "";

/** Pre-resolved theme, so the modal paints correctly on first frame. */
export const INITIAL_THEME =
  params.get(CONNECT_PARAM.theme) === "light" ? "light" : "dark";

/**
 * `postMessage` target for the parent frame, or null when the content script
 * could not supply a usable origin. Never `*`: with no named target the frame
 * stays silent rather than broadcasting to whoever embeds it.
 */
export function parentTargetOrigin(): string | null {
  try {
    const url = new URL(PARENT_ORIGIN);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // Fall through.
  }
  return null;
}

/**
 * Whether the page actually embedding this frame is the one the URL names.
 * A page that copies the frame URL into its own iframe cannot fake
 * `ancestorOrigins`, which the browser fills in. Browsers without it rely on
 * the worker's one-frame-per-request binding alone.
 */
export function embeddedByNamedParent(): boolean {
  const target = parentTargetOrigin();
  if (!target) return false;
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList })
    .ancestorOrigins;
  if (!ancestors) return true;
  return ancestors.length > 0 && ancestors[0] === target;
}
