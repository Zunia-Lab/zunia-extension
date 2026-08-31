import { CONNECT_CONFIG } from "../config/connect";
import "./style.css";

/**
 * Content script: config only for now.
 * Future: inject MAIN-world provider from web_accessible_resources after origin checks.
 */
export default defineContentScript({
  matches: [...CONNECT_CONFIG.contentScriptMatches],
  runAt: "document_start",
  // Isolated world; MAIN-world injection happens via separate script when implemented
  world: "ISOLATED",
  main() {
    // Provider bridge not implemented yet — see config/connect.ts
  },
});
