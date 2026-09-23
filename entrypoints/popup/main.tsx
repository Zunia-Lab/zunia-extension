import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { APPROVAL_UI_PORT } from "../../lib/approval-ui";
import App from "./App";
import "./style.css";

/**
 * Held open for the life of this page. The worker uses it to know a surface is
 * available for dApp requests, and treats its disconnect (popup closed, window
 * closed) as the user walking away from whatever request was on screen.
 * Opened outside React so a StrictMode remount cannot drop it.
 */
browser.runtime.connect({ name: APPROVAL_UI_PORT });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
