import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connectPortName } from "../../lib/connect-overlay";
import ConnectApp from "./App";
import { APPROVAL_ID } from "./params";
import "./style.css";

/**
 * Lifetime port, opened before React and never closed by us.
 *
 * The background treats the disconnect as "the user can no longer answer this
 * prompt" and rejects the pending approval. That covers every way this frame
 * can vanish — tab closed, page navigated, dApp ripped the overlay out of the
 * DOM — so the dApp's `enable()` promise always settles instead of hanging.
 *
 * It lives outside React on purpose: a StrictMode remount would otherwise
 * disconnect the port and cancel a perfectly live request.
 */
if (APPROVAL_ID) {
  browser.runtime.connect({ name: connectPortName(APPROVAL_ID) });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectApp />
  </StrictMode>,
);
