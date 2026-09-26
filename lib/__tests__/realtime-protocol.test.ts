import { describe, expect, it } from "vitest";

import {
  backoffDelay,
  coinsForAddress,
  decodeAttribute,
  parseCoins,
  parseFrame,
  subscribeFrame,
  subscriptionsFor,
  websocketUrl,
  MAX_BACKOFF_MS,
} from "../realtime-protocol";

const ADDRESS = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";

describe("websocketUrl", () => {
  it("upgrades the registry's https RPC to a wss subscription endpoint", () => {
    expect(websocketUrl("https://rpc-akash.keplr.app")).toBe(
      "wss://rpc-akash.keplr.app/websocket",
    );
  });

  it("keeps a local dev node on ws", () => {
    expect(websocketUrl("http://127.0.0.1:26657")).toBe("ws://127.0.0.1:26657/websocket");
  });

  it("does not double the slash on a registry row that ends in one", () => {
    expect(websocketUrl("https://rpc2.neutaro.io:443/")).toBe(
      "wss://rpc2.neutaro.io/websocket",
    );
  });

  it("keeps a path prefix, which several hosts route on", () => {
    expect(websocketUrl("https://do-chain.com/rpc")).toBe(
      "wss://do-chain.com/rpc/websocket",
    );
  });

  it("refuses anything it would have to guess at", () => {
    expect(websocketUrl(undefined)).toBeNull();
    expect(websocketUrl("")).toBeNull();
    expect(websocketUrl("rpc.example.com")).toBeNull();
    expect(websocketUrl("ftp://rpc.example.com")).toBeNull();
  });
});

describe("subscriptionsFor", () => {
  it("watches both sides, because only one of them is a transaction we signed", () => {
    const subs = subscriptionsFor("cosmoshub-4", ADDRESS);
    expect(subs.map((s) => s.direction)).toEqual(["received", "sent"]);
    expect(subs[0]!.query).toBe(
      `tm.event='Tx' AND transfer.recipient='${ADDRESS}'`,
    );
    expect(subs[1]!.query).toBe(`tm.event='Tx' AND message.sender='${ADDRESS}'`);
  });

  it("gives each subscription an id that survives the round trip", () => {
    const [incoming] = subscriptionsFor("osmosis-1", ADDRESS);
    const frame = subscribeFrame(incoming!);
    expect(frame.id).toBe(incoming!.id);
    expect(frame.method).toBe("subscribe");
    expect(frame.params).toEqual({ query: incoming!.query });
  });

  it("strips a quote rather than emitting a query the node will reject", () => {
    const [sub] = subscriptionsFor("custom-1", "abc'def");
    expect(sub!.query).toBe("tm.event='Tx' AND transfer.recipient='abcdef'");
  });
});

describe("decodeAttribute", () => {
  it("decodes the base64 a CometBFT 0.34 node sends", () => {
    expect(decodeAttribute(btoa("recipient"))).toBe("recipient");
    expect(decodeAttribute(btoa(ADDRESS))).toBe(ADDRESS);
  });

  it("leaves a plain string alone even when it is itself valid base64", () => {
    // "sender" is 6 chars and decodes without throwing; a naive decoder
    // turns it into mojibake on every modern node.
    expect(decodeAttribute("sender")).toBe("sender");
    expect(decodeAttribute("transfer")).toBe("transfer");
    expect(decodeAttribute("1000uatom")).toBe("1000uatom");
  });

  it("leaves an empty value alone", () => {
    expect(decodeAttribute("")).toBe("");
  });
});

describe("parseCoins", () => {
  it("splits at the first non-digit, so IBC denoms survive", () => {
    expect(
      parseCoins("1000ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2"),
    ).toEqual([
      {
        denom: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2",
        amount: "1000",
      },
    ]);
  });

  it("handles a token-factory denom, which contains both digits and slashes", () => {
    expect(parseCoins("5factory/osmo17fel472lgzs87ekt9dvk0zqyh5gl80sqp4sk4n/LAB")).toEqual([
      { denom: "factory/osmo17fel472lgzs87ekt9dvk0zqyh5gl80sqp4sk4n/LAB", amount: "5" },
    ]);
  });

  it("splits a multi-coin attribute", () => {
    expect(parseCoins("1000uatom,25uosmo")).toEqual([
      { denom: "uatom", amount: "1000" },
      { denom: "uosmo", amount: "25" },
    ]);
  });

  it("drops entries with no amount or no denom", () => {
    expect(parseCoins("uatom")).toEqual([]);
    expect(parseCoins("1000")).toEqual([]);
    expect(parseCoins("")).toEqual([]);
  });
});

describe("coinsForAddress", () => {
  const events = {
    "transfer.recipient": [ADDRESS, "cosmos1other", ADDRESS],
    "transfer.sender": ["cosmos1sender", ADDRESS, "cosmos1sender"],
    "transfer.amount": ["1000uatom", "7uatom", "500uatom"],
  };

  it("pairs each party with the amount at the same index", () => {
    expect(coinsForAddress(events, ADDRESS, "received")).toEqual([
      { denom: "uatom", amount: "1500" },
    ]);
  });

  it("reads the other side for an outgoing subscription", () => {
    expect(coinsForAddress(events, ADDRESS, "sent")).toEqual([
      { denom: "uatom", amount: "7" },
    ]);
  });

  it("sums per denom rather than listing a token twice", () => {
    expect(
      coinsForAddress(
        {
          "transfer.recipient": [ADDRESS, ADDRESS],
          "transfer.amount": ["1uatom", "2uosmo"],
        },
        ADDRESS,
        "received",
      ),
    ).toEqual([
      { denom: "uatom", amount: "1" },
      { denom: "uosmo", amount: "2" },
    ]);
  });

  it("returns nothing when the address is not a party", () => {
    expect(coinsForAddress(events, "cosmos1nobody", "received")).toEqual([]);
  });
});

describe("parseFrame", () => {
  const subscriptionId = `cosmoshub-4|${ADDRESS}|in`;

  function txFrame(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: subscriptionId,
      result: {
        query: "tm.event='Tx'",
        data: {
          type: "tendermint/event/Tx",
          value: { TxResult: { height: "19283746", result: { code: 0 } } },
        },
        events: {
          "tm.event": ["Tx"],
          "tx.hash": ["A1B2C3"],
          "tx.height": ["19283746"],
          "transfer.recipient": [ADDRESS],
          "transfer.amount": ["1250000uatom"],
          "message.action": ["/cosmos.bank.v1beta1.MsgSend"],
        },
        ...overrides,
      },
    });
  }

  it("reads an incoming transfer", () => {
    const frame = parseFrame(txFrame(), "cosmoshub-4");
    expect(frame).toMatchObject({
      kind: "tx",
      chainId: "cosmoshub-4",
      address: ADDRESS,
      direction: "received",
      hash: "A1B2C3",
      height: 19283746,
      coins: [{ denom: "uatom", amount: "1250000" }],
      action: "/cosmos.bank.v1beta1.MsgSend",
      succeeded: true,
    });
  });

  it("takes the direction from the subscription, not from the payload", () => {
    const raw = txFrame().replace("|in", "|out");
    const frame = parseFrame(raw, "cosmoshub-4");
    expect(frame).toMatchObject({ direction: "sent" });
  });

  it("marks an included but failed transaction as unsuccessful", () => {
    const raw = JSON.parse(txFrame()) as {
      result: { data: { value: { TxResult: { result: { code: number } } } } };
    };
    raw.result.data.value.TxResult.result.code = 11;
    const frame = parseFrame(JSON.stringify(raw), "cosmoshub-4");
    expect(frame).toMatchObject({ kind: "tx", succeeded: false });
  });

  it("reads a 0.34 node's base64 attributes", () => {
    const raw = JSON.parse(txFrame()) as {
      result: { events: Record<string, string[]> };
    };
    raw.result.events = {
      [btoa("tx.hash")]: [btoa("DEADBEEF")],
      [btoa("transfer.recipient")]: [btoa(ADDRESS)],
      [btoa("transfer.amount")]: [btoa("42uatom")],
    };
    const frame = parseFrame(JSON.stringify(raw), "cosmoshub-4");
    expect(frame).toMatchObject({
      kind: "tx",
      hash: "DEADBEEF",
      coins: [{ denom: "uatom", amount: "42" }],
    });
  });

  it("reads the empty result a subscribe is acknowledged with", () => {
    const raw = JSON.stringify({ jsonrpc: "2.0", id: subscriptionId, result: {} });
    expect(parseFrame(raw, "cosmoshub-4")).toEqual({
      kind: "ack",
      subscriptionId,
    });
  });

  it("surfaces an RPC error with its data attached", () => {
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: subscriptionId,
      error: { code: -32000, message: "Server error", data: "subscriptions disabled" },
    });
    expect(parseFrame(raw, "cosmoshub-4")).toEqual({
      kind: "error",
      subscriptionId,
      message: "Server error: subscriptions disabled",
    });
  });

  it("ignores anything it does not recognise rather than throwing", () => {
    expect(parseFrame("not json", "cosmoshub-4")).toEqual({ kind: "ignored" });
    expect(parseFrame("null", "cosmoshub-4")).toEqual({ kind: "ignored" });
    expect(parseFrame("{}", "cosmoshub-4")).toEqual({ kind: "ignored" });
    // A result with events but no tx.hash names nothing the wallet can act on.
    expect(
      parseFrame(
        JSON.stringify({ jsonrpc: "2.0", id: subscriptionId, result: { events: {} } }),
        "cosmoshub-4",
      ),
    ).toEqual({ kind: "ignored" });
  });
});

describe("backoffDelay", () => {
  it("grows with the attempt and stays inside the ceiling", () => {
    for (const attempt of [0, 1, 2, 5, 10, 50]) {
      const low = backoffDelay(attempt, () => 0);
      const high = backoffDelay(attempt, () => 1);
      expect(low).toBeGreaterThanOrEqual(1_000);
      expect(high).toBeLessThanOrEqual(MAX_BACKOFF_MS);
      expect(high).toBeGreaterThanOrEqual(low);
    }
  });

  it("jitters, so every wallet watching one node does not retry in lockstep", () => {
    expect(backoffDelay(6, () => 0)).not.toBe(backoffDelay(6, () => 1));
  });

  it("is capped, so a node that is down is retried once a minute at worst", () => {
    expect(backoffDelay(100, () => 1)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  });
});
