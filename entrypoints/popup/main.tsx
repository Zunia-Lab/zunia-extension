import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { holdApprovalUiPort } from "../../lib/approval-ui";
import App from "./App";
import "./style.css";

/**
 * The worker uses this page's port to know a surface is available for dApp
 * requests, and treats its disconnect (popup closed, window closed) as the
 * user walking away from whatever request was on screen. Held outside React
 * so a StrictMode remount cannot drop it.
 */
holdApprovalUiPort();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
