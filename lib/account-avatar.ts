/**
 * Distinct 3D orb seeds per account. Same helper the UI uses (FNV + 12
 * palettes), so two accounts are not given the same colour by accident.
 */

const PALETTE_COUNT = 16;

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function paletteIndexOf(seed: string): number {
  return hashSeed(seed.trim().toLowerCase() || "zunia") % PALETTE_COUNT;
}

/** A seed whose palette is not already used, when any unused colour remains. */
export function pickAvatarSeed(taken: readonly string[]): string {
  const used = new Set(taken.map(paletteIndexOf));
  for (let i = 0; i < 48; i++) {
    const seed = `orb-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 10)}`;
    if (used.size >= PALETTE_COUNT || !used.has(paletteIndexOf(seed))) {
      return seed;
    }
  }
  return `orb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function avatarSeedOf(account: {
  avatarSeed?: string;
  index: number;
  address: string;
}): string {
  return account.avatarSeed || `acct-${account.index}:${account.address}`;
}

/** HD path index: own-seed accounts always derive at 0. */
export function derivationIndexOf(account: {
  index: number;
  ownSeed?: boolean;
}): number {
  return account.ownSeed ? 0 : account.index;
}
