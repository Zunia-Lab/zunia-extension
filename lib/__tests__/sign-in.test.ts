import { describe, expect, it } from "vitest";
import vectors from "./fixtures/sign-in-vectors.json";
import { ProviderError } from "../provider-errors";
import {
  SIGN_IN_LIMITS,
  assertSignInBinding,
  looksLikeSignIn,
  parseSignInMessage,
} from "../sign-in";

const join = (lines: string[]) => lines.join("\n");

/** "ok", or the code of the ProviderError the call threw. */
function outcome(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof ProviderError ? err.code : `unexpected ${String(err)}`;
  }
  return "ok";
}

describe("sign-in vectors", () => {
  it.each(vectors.valid.map((v) => [v.name, v] as const))("parses %s", (_name, vector) => {
    expect(parseSignInMessage(join(vector.lines))).toEqual(vector.fields);
  });

  it.each(vectors.invalid.map((v) => [v.name, v] as const))("refuses %s", (_name, vector) => {
    expect(outcome(() => parseSignInMessage(join(vector.lines)))).toBe("INVALID_PARAMS");
  });

  it.each(vectors.binding.map((v) => [v.name, v] as const))("binding: %s", (_name, vector) => {
    const result = outcome(() =>
      assertSignInBinding(parseSignInMessage(join(vector.lines)), {
        origin: vector.origin,
        chainId: vector.chainId,
        signer: vector.signer,
        now: Date.parse(vector.now),
      }),
    );
    expect(result).toBe(vector.expect);
  });
});

describe("looksLikeSignIn", () => {
  it("catches the phrase in any wording, case or line ending", () => {
    expect(looksLikeSignIn(join(vectors.valid[0]!.lines))).toBe(true);
    expect(looksLikeSignIn(join(vectors.invalid[0]!.lines))).toBe(true);
    expect(looksLikeSignIn("x.com WANTS YOU TO SIGN IN WITH YOUR Cosmos account:\r\n")).toBe(true);
    expect(looksLikeSignIn("Hi\n\nsite.com wants you to sign in with your wallet")).toBe(true);
  });

  it("leaves plain messages alone", () => {
    expect(looksLikeSignIn("Hello from Zunia")).toBe(false);
    expect(looksLikeSignIn("Sign this message to verify ownership: 1234")).toBe(false);
  });
});

describe("parseSignInMessage limits", () => {
  it("refuses a message over the size limit before reading it", () => {
    const base = join(vectors.valid[1]!.lines);
    const padded = base.replace(
      "Sign in to Example. This request does not move funds.",
      "a".repeat(SIGN_IN_LIMITS.maxLength),
    );
    expect(outcome(() => parseSignInMessage(padded))).toBe("INVALID_PARAMS");
  });

  it("refuses a statement over its own limit", () => {
    const base = join(vectors.valid[1]!.lines);
    const long = base.replace(
      "Sign in to Example. This request does not move funds.",
      "a".repeat(SIGN_IN_LIMITS.maxStatement + 1),
    );
    expect(outcome(() => parseSignInMessage(long))).toBe("INVALID_PARAMS");
  });
});
