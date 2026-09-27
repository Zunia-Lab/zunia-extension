import { describe, expect, it } from "vitest";

import {
  avatarSeedOf,
  derivationIndexOf,
  paletteIndexOf,
  pickAvatarSeed,
} from "../account-avatar";

describe("account avatars", () => {
  it("picks a seed whose palette is not already taken", () => {
    const first = pickAvatarSeed([]);
    const second = pickAvatarSeed([first]);
    expect(paletteIndexOf(first)).not.toBe(paletteIndexOf(second));
  });

  it("falls back to index + address when no seed was stored", () => {
    expect(avatarSeedOf({ index: 2, address: "cosmos1abc" })).toBe(
      "acct-2:cosmos1abc",
    );
  });
});

describe("derivationIndexOf", () => {
  it("uses HD index for legacy extras and 0 for own-seed accounts", () => {
    expect(derivationIndexOf({ index: 3 })).toBe(3);
    expect(derivationIndexOf({ index: 3, ownSeed: true })).toBe(0);
  });
});
