import { describe, expect, it } from "vitest";

import {
  expectedSequenceOf,
  isSequenceMismatch,
  parseAccountBody,
} from "../broadcast";

describe("parseAccountBody", () => {
  it("unwraps a nested vesting account instead of reading a zero outer sequence", () => {
    const parsed = parseAccountBody({
      account: {
        "@type": "/cosmos.vesting.v1beta1.ContinuousVestingAccount",
        account_number: "0",
        base_vesting_account: {
          base_account: {
            address: "addr_safro1owner",
            account_number: "12",
            sequence: "36",
          },
        },
      },
    });
    expect(parsed.accountNumber).toBe("12");
    expect(parsed.sequence).toBe("36");
  });

  it("treats a never-used account as sequence 0", () => {
    const parsed = parseAccountBody({
      account: {
        "@type": "/cosmos.auth.v1beta1.BaseAccount",
        address: "addr_safro1owner",
        account_number: "4",
      },
    });
    expect(parsed.accountNumber).toBe("4");
    expect(parsed.sequence).toBe("0");
  });
});

describe("sequence mismatch", () => {
  it("reads the sequence the chain asked for", () => {
    const error = new Error(
      "account sequence mismatch, expected 36, got 0: incorrect account sequence",
    );
    expect(isSequenceMismatch(error)).toBe(true);
    expect(expectedSequenceOf(error)).toBe("36");
  });
});
