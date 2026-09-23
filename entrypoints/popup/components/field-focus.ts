/**
 * Focus for a bordered box around a bare input, such as the large amount
 * fields and the QR file picker. The box lights up the way `Input` does, since
 * the input inside draws no ring of its own. Buttons in the same box do not
 * trigger it.
 */
export const fieldFocusWithin = [
  "transition-[background-color,border-color,box-shadow] duration-[var(--z-duration-base)]",
  "has-[input:focus-visible]:border-[color-mix(in_srgb,var(--z-accent)_55%,var(--z-line))]",
  "has-[input:focus-visible]:shadow-[0_0_0_1px_var(--z-focus-ring)]",
].join(" ");
