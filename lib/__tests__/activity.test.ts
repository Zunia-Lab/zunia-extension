import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { watchUserActivity } from "../activity";

describe("watchUserActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports at once, then at most once per interval", () => {
    const target = new EventTarget();
    const report = vi.fn();
    watchUserActivity(target, report, 30_000);
    expect(report).toHaveBeenCalledTimes(1);

    vi.setSystemTime(29_999);
    target.dispatchEvent(new Event("pointerdown"));
    target.dispatchEvent(new Event("keydown"));
    expect(report).toHaveBeenCalledTimes(1);

    vi.setSystemTime(30_000);
    target.dispatchEvent(new Event("wheel"));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("ignores events that are not input", () => {
    const target = new EventTarget();
    const report = vi.fn();
    watchUserActivity(target, report, 30_000);

    vi.setSystemTime(60_000);
    target.dispatchEvent(new Event("mousemove"));
    target.dispatchEvent(new Event("focus"));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("stops reporting once stopped", () => {
    const target = new EventTarget();
    const report = vi.fn();
    const stop = watchUserActivity(target, report, 30_000);
    stop();

    vi.setSystemTime(60_000);
    target.dispatchEvent(new Event("pointerdown"));
    expect(report).toHaveBeenCalledTimes(1);
  });
});
