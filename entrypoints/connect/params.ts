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
 * `postMessage` target for the parent frame. Falls back to `*` when the
 * content script could not supply a usable origin — acceptable only because
 * the payload is limited to "close me" / "I am this tall", which carries no
 * secret and grants no authority.
 */
export function parentTargetOrigin(): string {
  try {
    const url = new URL(PARENT_ORIGIN);
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // Fall through.
  }
  return "*";
}
