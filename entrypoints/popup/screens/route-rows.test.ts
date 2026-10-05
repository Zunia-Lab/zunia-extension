import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Each hop row carries its closed channel editor, a radix Dialog that the
// linked @zunialab/ui resolves against its own React copy under vitest. The
// rows are what is checked here; the closed editor renders nothing anyway.
vi.mock("@zunialab/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zunialab/ui")>()),
  Dialog: () => null,
}));

import { pathHopViews, type ManualChannel } from "../../../lib/route-plan";
import type { PendingTransfer } from "../../../lib/pending-transfers";
import { transferLabel } from "../../../lib/send-arrival";
import { identityOf } from "../../../lib/token-identity";
import { InFlightRow, RouteLabel } from "./ActivityScreen";
import { HopChannelList, swapRouteLabel } from "./interchain-ui";

/**
 * Two rows that name a route: Activity's in-flight row (the label a pending
 * swap or transfer was saved with) and the per-hop channel rows Send and Swap
 * show under a route. Rendered to markup, the way the popup renders them.
 */

const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";

/** The text a reader gets: tags dropped, entities read. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
}

/** Each side box RouteLabel draws, in order. */
function sidesOf(html: string): string[] {
  return [...html.matchAll(/<span class="inline-block max-w-full">([^<]*)<\/span>/g)].map((match) => textOf(match[1] ?? ""));
}

const route = (label: string) => renderToStaticMarkup(createElement(RouteLabel, { label }));

describe("Activity's in-flight label", () => {
  // A swap's label as SwapScreen saves it, and a transfer's as SendScreen does.
  const swap = swapRouteLabel("10000000", identityOf("osmosis-1", "uosmo"), {
    ticker: identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS).ticker,
    heldOnChainName: "Axelar",
  });
  const sent = transferLabel(10_000_000n, identityOf("osmosis-1", USDC_N_ON_OSMOSIS), "Noble");

  it("breaks between a route's two sides, never inside one", () => {
    expect(swap).toBe("10 OSMO (Osmosis) → USDC.axl (Axelar)");
    expect(sidesOf(route(swap))).toEqual(["10 OSMO (Osmosis)", "→ USDC.axl (Axelar)"]);
    expect(sent).toBe("10 USDC.n (Osmosis) → Noble");
    expect(sidesOf(route(sent))).toEqual(["10 USDC.n (Osmosis)", "→ Noble"]);
    // A record saved by 0.1.2, and one with no arrow at all.
    expect(sidesOf(route("1.5 ATOM → OSMO"))).toEqual(["1.5 ATOM", "→ OSMO"]);
    expect(sidesOf(route("12.5 → ?"))).toEqual(["12.5", "→ ?"]);
    expect(sidesOf(route("Swap"))).toEqual(["Swap"]);
  });

  it("reads as the stored label, word for word", () => {
    for (const label of [swap, sent, "1.5 ATOM → OSMO", "Swap", "a → b → c"]) {
      expect(textOf(route(label))).toBe(label);
    }
  });

  it("wraps instead of cutting the label", () => {
    const record: PendingTransfer = {
      kind: "swap",
      txHash: "ABCDEF",
      chainId: "osmosis-1",
      plan: { sourceChainId: "osmosis-1", destChainId: "axelar-dojo-1", hops: [] } as unknown as PendingTransfer["plan"],
      amountBaseUnits: "10000000",
      label: swap,
      startedAt: Date.parse("2026-10-05T12:00:00Z"),
    };
    const html = renderToStaticMarkup(createElement(InFlightRow, { record, onOpen: () => undefined }));
    // The box around the two sides: it wraps, and nothing clips or clamps it.
    const label = /<span class="([^"]*)"><span class="inline-block/.exec(html);
    const classes = (label?.[1] ?? "").split(" ");
    expect(classes).toContain("[overflow-wrap:anywhere]");
    expect(classes.filter((name) => /^(truncate|line-clamp-|overflow-hidden|text-ellipsis)/.test(name))).toEqual([]);
    expect(sidesOf(html)).toEqual(["10 OSMO (Osmosis)", "→ USDC.axl (Axelar)"]);
    // The status line keeps its whole text in its title.
    expect(textOf(html)).toContain("Osmosis to Axelar");
    expect(html).toMatch(/title="Osmosis to Axelar · [^"]+"/);
  });
});

describe("the hop channel rows under a route", () => {
  const open = (sourceChainId: string, destChainId: string, channelId: string) =>
    ({ sourceChainId, destChainId, channelId, port: "transfer", state: "open", source: "seed" }) as const;
  const list = (hops: ReturnType<typeof pathHopViews>, manual: ManualChannel[] = []) =>
    renderToStaticMarkup(
      createElement(HopChannelList, { hops, manual, onPick: () => undefined, onClear: () => undefined }),
    );
  /** Each row's channel line: what it shows, and the title it carries. */
  const lines = (html: string) =>
    [...html.matchAll(/<span class="([^"]*)" title="([^"]*)">(.*?)<\/span><span class="mt-0\.5/g)].map((match) => ({
      classes: match[1] ?? "",
      title: textOf(match[2] ?? ""),
      text: textOf(match[3] ?? ""),
    }));

  it("names the chain the channel leads to, and keeps the ids in the title", () => {
    const html = list(pathHopViews([open("osmosis-1", "noble-1", "channel-750")]));
    expect(lines(html)).toEqual([
      expect.objectContaining({
        text: "channel-750 to Noble (auto)",
        title: "channel-750 on osmosis-1 to noble-1",
      }),
    ]);
    // The id is in the title, not on screen.
    expect(textOf(html)).not.toContain("noble-1");
  });

  it("numbers each hop of a longer route, and marks a channel chosen by hand", () => {
    const hops = pathHopViews([open("osmosis-1", "cosmoshub-4", "channel-0"), open("cosmoshub-4", "noble-1", "channel-536")]);
    const manual: ManualChannel[] = [
      { fromChainId: "cosmoshub-4", toChainId: "noble-1", channelId: "channel-536", verdict: "verified" },
    ];
    expect(lines(list(hops, manual)).map(({ text, title }) => [text, title])).toEqual([
      ["Hop 1: channel-0 to Cosmos Hub (auto)", "channel-0 on osmosis-1 to cosmoshub-4"],
      ["Hop 2: channel-536 to Noble (manual)", "channel-536 on cosmoshub-4 to noble-1"],
    ]);
  });

  it("wraps a long chain name instead of cutting it, and falls back to the id for a chain it does not know", () => {
    const html = list(pathHopViews([open("osmosis-1", "buenavista-1", "channel-12345"), open("buenavista-1", "mychain-1", "channel-7")]));
    const rows = lines(html);
    expect(rows.map(({ text }) => text)).toEqual([
      "Hop 1: channel-12345 to Warden Protocol Buenavista (auto)",
      "Hop 2: channel-7 to mychain-1 (auto)",
    ]);
    for (const row of rows) {
      expect(row.classes.split(" ")).not.toContain("truncate");
      expect(row.classes.split(" ")).toContain("[overflow-wrap:anywhere]");
    }
  });
});
