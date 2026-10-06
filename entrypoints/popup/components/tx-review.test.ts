import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TrackedRoute } from "../../../lib/packet-tracking";
import { identityOf } from "../../../lib/token-identity";
import {
  ConfirmFooter,
  RawTxDisclosure,
  ReviewDisclosure,
  TransferProgress,
  TxStatusHero,
  explainTxError,
  rawTxJson,
  routeSteps,
} from "./TxReview";

/**
 * The pieces every transaction screen is built from (TxReview.tsx): what is
 * shown at once, what is folded, and the words for where a transaction stands.
 */

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const HASH = "A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90";

function route(statuses: ("pending" | "relayed" | "received" | "acknowledged" | "timeout")[], failure: TrackedRoute["failure"] = null): TrackedRoute {
  return {
    hops: statuses.map((status, i) => ({
      chainId: i === 0 ? "osmosis-1" : "cosmoshub-4",
      chainName: i === 0 ? "Osmosis" : "Cosmos Hub",
      counterpartyChainId: i === 0 ? "cosmoshub-4" : "noble-1",
      counterpartyChainName: i === 0 ? "Cosmos Hub" : "Noble",
      channelId: i === 0 ? "channel-0" : "channel-536",
      port: "transfer",
      sequence: "12",
      sendTxHash: HASH,
      receiveTxHash: null,
      status,
    })),
    status: statuses[statuses.length - 1] ?? "pending",
    failure,
    stalled: false,
    currentHopIndex: 0,
    estimatedDurationSeconds: 90,
    elapsedSeconds: 30,
    updatedAt: 0,
    settled: false,
    recovery: null,
    notes: [],
    sourceError: null,
  };
}

describe("a chain's error in plain words", () => {
  it("names the usual refusals, and keeps the chain's own text as the detail", () => {
    const slippage = explainTxError(
      "failed to execute message; message index: 0: token amount calculated (352436) is lesser than min amount (704872)",
    );
    expect(slippage.message).toMatch(/^The price moved more than your slippage allows/);
    expect(slippage.detail).toMatch(/lesser than min amount/);
    expect(explainTxError("insufficient fees; got: 10uosmo required: 400uosmo").message).toMatch(/network fee was too low/);
    expect(explainTxError("out of gas in location: WritePerByte; gasWanted: 100").message).toMatch(/ran out of gas/);
    expect(explainTxError("spendable balance 10uosmo is smaller than 20uosmo: insufficient funds").message).toMatch(
      /not enough balance/,
    );
    expect(explainTxError("account sequence mismatch, expected 5, got 4").message).toMatch(/went first/);
  });

  it("keeps an error it does not know as the chain wrote it, with nothing folded", () => {
    expect(explainTxError("unauthorized: signature verification failed")).toEqual({
      message: "unauthorized: signature verification failed",
      detail: null,
    });
    expect(explainTxError("  ").message).toBe("The chain refused this transaction.");
  });
});

describe("the result of a transaction", () => {
  it("says the status, the amount and the hash, with the chain's error folded", () => {
    const explained = explainTxError("token amount calculated (1) is lesser than min amount (2)");
    const html = renderToStaticMarkup(
      h(TxStatusHero, {
        status: "failed",
        title: "Not swapped",
        amount: "≈ 0.35 USDC.inj",
        line: "for 9.95 OSMO",
        message: explained.message,
        errorDetail: explained.detail,
        txHash: HASH,
      }),
    );
    const shown = text(html);
    expect(shown).toContain("Not swapped");
    expect(shown).toContain("≈ 0.35 USDC.inj");
    expect(shown).toContain("The price moved more than your slippage allows");
    // The chain's text is there to open, not shown at once.
    expect(html).toMatch(/<details class="group mt-2[^"]*"><summary/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain(`title="${HASH}"`);
    expect(html).toContain(`aria-label="Copy the transaction hash: ${HASH}"`);
  });

  it("is announced to assistive tech as it changes", () => {
    const html = renderToStaticMarkup(h(TxStatusHero, { status: "pending", title: "Confirming" }));
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });
});

describe("a route in flight", () => {
  it("draws each chain the funds pass, and how far they got", () => {
    expect(routeSteps(route(["acknowledged", "relayed"]), "Osmosis", "Noble")).toEqual([
      { label: "Osmosis", state: "done" },
      { label: "Cosmos Hub", state: "done" },
      { label: "Noble", state: "current" },
    ]);
    expect(routeSteps(route(["timeout"]), "Osmosis", "Cosmos Hub")).toEqual([
      { label: "Osmosis", state: "done" },
      { label: "Cosmos Hub", state: "error" },
    ]);
    // Before the first poll answers, and when the signed transaction failed.
    expect(routeSteps(null, "Osmosis", "Noble")).toEqual([
      { label: "Osmosis", state: "current" },
      { label: "Noble", state: "waiting" },
    ]);
    expect(routeSteps({ hops: [], failure: "source-failed" }, "Osmosis", "Noble")[0]?.state).toBe("error");
  });

  it("leads with where the funds are and folds the tracker's details", () => {
    const html = renderToStaticMarkup(
      h(TransferProgress, {
        amount: "25 OSMO",
        identity: identityOf("osmosis-1", "uosmo"),
        fromChainName: "Osmosis",
        toChainName: "Noble",
        route: route(["acknowledged", "relayed"]),
        loading: false,
        error: null,
        onRefresh: () => undefined,
        txHash: HASH,
        sourceChainId: "osmosis-1",
        txUrl: () => null,
      }),
    );
    const shown = text(html);
    expect(shown).toContain("25 OSMO");
    expect(shown).toContain("Osmosis → Noble");
    expect(shown).toContain("Moving");
    expect(shown).toMatch(/About 60s left\./);
    expect(html).toMatch(/<details class="group[^"]*"><summary/);
    expect(shown).toContain("Transfer details");
    expect(html).not.toMatch(/<details[^>]* open/);
  });
});

describe("before signing", () => {
  it("starts every folded section closed, the raw JSON included", () => {
    const json = rawTxJson({ chainId: "osmosis-1", memo: "m", fee: { gas: "1" }, messages: [{ a: 1 }] });
    expect(JSON.parse(json)).toEqual({ chain_id: "osmosis-1", memo: "m", fee: { gas: "1" }, messages: [{ a: 1 }] });
    for (const html of [
      renderToStaticMarkup(h(ReviewDisclosure, { title: "Transaction details", children: "x" })),
      renderToStaticMarkup(h(RawTxDisclosure, { json })),
    ]) {
      expect(html.startsWith("<details")).toBe(true);
      expect(html).not.toMatch(/<details[^>]* open/);
    }
  });

  it("says why signing is off on the button, and what it does when it is on", () => {
    const off = text(
      renderToStaticMarkup(
        h(ConfirmFooter, { busy: false, label: "Cannot sign", disabled: true, onBack: () => undefined, onSign: () => undefined }),
      ),
    );
    expect(off).toContain("Cannot sign");
    const on = text(
      renderToStaticMarkup(h(ConfirmFooter, { busy: false, action: "Sign stake", onBack: () => undefined, onSign: () => undefined })),
    );
    expect(on).toContain("Sign stake");
    expect(text(renderToStaticMarkup(h(ConfirmFooter, { busy: true, onBack: () => undefined, onSign: () => undefined })))).toContain(
      "Signing…",
    );
  });
});
