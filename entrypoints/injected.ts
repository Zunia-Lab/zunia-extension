import { CONNECT_CONFIG } from "../config/connect";

/**
 * Unlisted MAIN-world script placeholder.
 * Will expose window.zunia (and optional keplr alias) once implemented.
 */
export default defineUnlistedScript(() => {
  void CONNECT_CONFIG.provider.globalName;
  // window.zunia = ... (not implemented yet)
});
