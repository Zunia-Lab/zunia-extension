import { defineConfig } from "wxt";

// Targets: Chrome, Firefox, Edge, Safari (Safari packaging needs Xcode on macOS)
export default defineConfig({
  manifest: {
    name: "Zunia",
    description: "Multi-chain Cosmos wallet. Browser extension for Chrome, Firefox, Edge, and Safari.",
    permissions: ["storage"],
    host_permissions: ["https://*/*", "http://localhost/*"],
    browser_specific_settings: {
      gecko: {
        id: "extension@zuniawallet.com",
        strict_min_version: "120.0",
      },
    },
  },
});
