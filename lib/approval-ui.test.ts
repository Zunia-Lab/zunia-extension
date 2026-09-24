/**
 * Where a request goes when the wallet needs the user's answer. The case these tests pin
 * down is Safari on iOS: no windows API, so without a tab fallback every dApp request would
 * wait with nothing on screen until it timed out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const POPUP_URL = "safari-web-extension://abc/popup.html";

type Stub = {
  openPopup?: () => Promise<void>;
  windowsCreate?: (opts: unknown) => Promise<unknown>;
  tabsCreate: (opts: unknown) => Promise<unknown>;
};

function installBrowser(stub: Stub): void {
  vi.stubGlobal("browser", {
    action: stub.openPopup ? { openPopup: stub.openPopup } : {},
    runtime: { getURL: (path: string) => POPUP_URL.replace("popup.html", path) },
    windows: stub.windowsCreate ? { create: stub.windowsCreate } : undefined,
    tabs: { create: stub.tabsCreate },
  });
}

async function freshModule() {
  vi.resetModules();
  return import("./approval-ui");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openApprovalUi", () => {
  it("prefers the toolbar popup", async () => {
    const openPopup = vi.fn(async () => undefined);
    const windowsCreate = vi.fn(async () => ({}));
    const tabsCreate = vi.fn(async () => ({}));
    installBrowser({ openPopup, windowsCreate, tabsCreate });
    const { openApprovalUi } = await freshModule();
    await openApprovalUi();
    expect(openPopup).toHaveBeenCalledOnce();
    expect(windowsCreate).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("opens a popup window when the toolbar popup cannot open", async () => {
    const openPopup = vi.fn(async () => {
      throw new Error("no gesture");
    });
    const windowsCreate = vi.fn(async (_opts: unknown) => ({}));
    const tabsCreate = vi.fn(async () => ({}));
    installBrowser({ openPopup, windowsCreate, tabsCreate });
    const { openApprovalUi } = await freshModule();
    await openApprovalUi();
    expect(windowsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${POPUP_URL}?approve=1`, type: "popup" }),
    );
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it("opens a tab where the browser has no windows API (Safari on iOS)", async () => {
    const openPopup = vi.fn(async () => {
      throw new Error("no gesture");
    });
    const tabsCreate = vi.fn(async (_opts: unknown) => ({}));
    installBrowser({ openPopup, tabsCreate });
    const { openApprovalUi } = await freshModule();
    await openApprovalUi();
    expect(tabsCreate).toHaveBeenCalledWith({ url: `${POPUP_URL}?approve=1`, active: true });
  });

  it("opens one surface for a burst of requests", async () => {
    const tabsCreate = vi.fn(async (_opts: unknown) => ({}));
    installBrowser({ tabsCreate });
    const { openApprovalUi } = await freshModule();
    await Promise.all([openApprovalUi(), openApprovalUi(), openApprovalUi()]);
    expect(tabsCreate).toHaveBeenCalledOnce();
  });
});
