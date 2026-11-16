import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RecheckButton, RecheckControl, checkedAgo, recheckNote } from "./RecheckButton";

/**
 * The control behind every "check again": its look at rest and while running,
 * and the words a finished check leaves.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("RecheckButton", () => {
  it("is a real, enabled button at rest", () => {
    const html = renderToStaticMarkup(h(RecheckButton, { checking: false, onClick: () => {} }));
    expect(html).toContain("<button");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("aria-busy=");
    expect(text(html)).toBe("Check again");
  });

  it("is disabled, busy and says Checking… while the check runs", () => {
    const html = renderToStaticMarkup(h(RecheckButton, { checking: true, onClick: () => {} }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("z-spinner");
    expect(text(html)).toContain("Checking…");
    expect(text(html)).not.toContain("Check again");
  });

  it("takes the label the screen gives it", () => {
    const html = renderToStaticMarkup(
      h(RecheckButton, { checking: false, onClick: () => {}, label: "Check the channel again" }),
    );
    expect(text(html)).toBe("Check the channel again");
  });
});

describe("RecheckControl", () => {
  const press = () => {};

  it("says nothing before the first check ends", () => {
    const html = renderToStaticMarkup(
      h(RecheckControl, { recheck: { checking: false, finishedAt: null, press }, still: "Still unavailable" }),
    );
    expect(text(html)).toBe("Check again");
  });

  it("says nothing while a check runs, even after an earlier one", () => {
    const html = renderToStaticMarkup(
      h(RecheckControl, { recheck: { checking: true, finishedAt: 1_000, press }, still: "Still unavailable" }),
    );
    expect(text(html)).not.toContain("Still unavailable");
    expect(text(html)).toContain("Checking…");
  });

  it("says what is still true once a check has ended", () => {
    const html = renderToStaticMarkup(
      h(RecheckControl, { recheck: { checking: false, finishedAt: Date.now(), press }, still: "Still unavailable" }),
    );
    expect(text(html)).toContain("Still unavailable — checked just now");
  });
});

describe("recheckNote", () => {
  it("counts from when the check ended", () => {
    expect(checkedAgo(10_000, 10_000)).toBe("just now");
    expect(checkedAgo(10_000, 19_999)).toBe("just now");
    expect(checkedAgo(10_000, 22_000)).toBe("12 s ago");
    expect(checkedAgo(10_000, 10_000 + 120_000)).toBe("2 min ago");
  });

  it("never reads a clock that is behind as the future", () => {
    expect(checkedAgo(10_000, 5_000)).toBe("just now");
  });

  it("joins the sentence and the time", () => {
    expect(recheckNote("Still failing", 0, 30_000)).toBe("Still failing — checked 30 s ago");
  });
});
