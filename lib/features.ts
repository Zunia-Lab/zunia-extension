/**
 * Features that depend on the store a build ships to.
 *
 * In-app swaps are left out of the Safari build. App Review counts them as an
 * exchange service under guideline 3.1.5(iii): it rejected macOS 0.1.9 and
 * 0.1.11 for them, and asks for an exchange licence in every storefront. So the
 * Mac and iPhone apps ship the wallet without the Swap screen. Chrome, Edge and
 * Firefox keep it, and so do Zunia Wallet and app.zunialab.com.
 *
 * This is decided when the bundle is built, never at run time, so there is no
 * hidden switch in the Safari app: the swap screen cannot be reached there at
 * all. It is written as a direct comparison so the bundler can fold it to a
 * constant and drop the code behind it.
 */
export const SWAP_ENABLED: boolean = import.meta.env.BROWSER !== "safari";

/** `items` without the swap entry when this build has no swaps. */
export function withoutSwap<T extends { readonly id: string }>(
  items: readonly T[],
  swapEnabled: boolean = SWAP_ENABLED,
): T[] {
  return swapEnabled ? [...items] : items.filter((item) => item.id !== "swap");
}
