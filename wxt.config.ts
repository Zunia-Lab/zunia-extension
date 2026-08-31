import { defineConfig } from "wxt";
import { CONNECT_CONFIG } from "./config/connect";

// Targets: Chrome, Firefox, Edge, Safari (Safari packaging needs Xcode on macOS)
export default defineConfig({
  manifest: {
    name: "Zunia",
    description:
      "Multi-chain Cosmos wallet. Browser extension for Chrome, Firefox, Edge, and Safari.",
    // Minimal privileges for future secure dApp connect (no broad clipboard / tabs yet)
    permissions: ["storage", "alarms"],
    host_permissions: [
      "https://*/*",
      "http://localhost/*",
      "http://127.0.0.1/*",
    ],
    // First-party web apps may talk to the extension over runtime messaging
    externally_connectable: {
      matches: [...CONNECT_CONFIG.externallyConnectableMatches],
    },
    // Injected provider must be listed so content scripts can load it into pages
    web_accessible_resources: [
      {
        resources: ["injected.js", "content-scripts/injected.js"],
        matches: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
      },
    ],
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'self'; frame-ancestors 'none';",
    },
    browser_specific_settings: {
      gecko: {
        id: "extension@zuniawallet.com",
        strict_min_version: "120.0",
      },
    },
  },
});
