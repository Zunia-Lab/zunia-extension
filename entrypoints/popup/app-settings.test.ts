import { act, createElement, type ComponentType } from "react";
import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OPTIONAL_HOST_PERMISSIONS, REALTIME_HOST_PERMISSIONS } from "../../config/hosts";
import { DEFAULT_SETTINGS, type ExtensionSettings } from "../../lib/settings";
import type { SessionStatus } from "../../lib/session";

/**
 * The popup shell rendered for real (App, useExtensionState, PrefsProvider and
 * the Notifications and Preferences screens) against a fake worker.
 *
 * 1. A saved preference applies in place. PrefsProvider used to call the
 *    state hook's `refresh`, which reads as loading, and App shows its boot
 *    view ("Opening wallet…") while loading. The open screen unmounted and came
 *    back scrolled to the top: the 0.1.3 UX review measured Notifications'
 *    Staking rewards control going from scrollTop 142 to 0.
 * 2. Notifications says chain reads are on or off from the flag Home uses (the
 *    live balances setting and the host access it needs), not from the setting
 *    alone, which is on by default on a fresh install that has no access yet.
 *
 * Vitest runs in node here and the repo has no DOM library, so this file
 * carries the parts of a DOM that React DOM touches: nodes, attributes, text,
 * and events dispatched through the listeners React puts on its root. Home is
 * a stub (its own tests cover it) and Radix's Switch is a plain button, since
 * it mirrors itself into a hidden form input this DOM does not model.
 */

/**
 * One React for the whole tree. The bundle gets that from wxt.config.ts, which
 * aliases `react` to a single copy. Vitest instead loads @zunialab/ui's Radix
 * dependencies natively, each with the React installed next to it in
 * zunia-ui, so this file takes that copy too (the same 19.2.x release), and
 * React DOM with it. Two copies fail on the first hook.
 */
const reactOfUi = vi.hoisted(() => async (specifier: string) => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ui = realpathSync(path.resolve(here, "../../node_modules/@zunialab/ui"));
  return import(createRequire(path.join(ui, "package.json")).resolve(specifier));
});
vi.mock("react", () => reactOfUi("react"));
vi.mock("react/jsx-runtime", () => reactOfUi("react/jsx-runtime"));
vi.mock("react/jsx-dev-runtime", () => reactOfUi("react/jsx-dev-runtime"));
vi.mock("react-dom", () => reactOfUi("react-dom"));
vi.mock("react-dom/client", () => reactOfUi("react-dom/client"));

vi.mock("./screens/HomeScreen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./screens/HomeScreen")>();
  const react = await import("react");
  return {
    ...actual,
    HomeScreen: ({ onNavigate }: { onNavigate: (route: string) => void }) =>
      react.createElement(
        "button",
        { type: "button", onClick: () => onNavigate("notifications") },
        "Open notifications",
      ),
  };
});

vi.mock("@zunialab/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zunialab/ui")>();
  const react = await import("react");
  return {
    ...actual,
    Switch: ({
      checked,
      disabled,
      onCheckedChange,
    }: {
      checked?: boolean;
      disabled?: boolean;
      onCheckedChange?: (next: boolean) => void;
    }) =>
      react.createElement("button", {
        type: "button",
        role: "switch",
        "aria-checked": Boolean(checked),
        disabled,
        onClick: () => onCheckedChange?.(!checked),
      }),
  };
});

/* -------------------------------------------------------------------------- *
 * A DOM for React DOM
 * -------------------------------------------------------------------------- */

const HTML_NS = "http://www.w3.org/1999/xhtml";

type Listener = (event: FakeEvent) => void;
type ListenerOptions = boolean | { capture?: boolean; passive?: boolean };

class FakeEvent {
  readonly timeStamp = Date.now();
  readonly isTrusted = false;
  readonly button = 0;
  readonly buttons = 0;
  readonly detail = 1;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  propagationStopped = false;

  constructor(
    readonly type: string,
    readonly bubbles = false,
    readonly cancelable = false,
  ) {}

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

function isCapture(options?: ListenerOptions): boolean {
  return typeof options === "boolean" ? options : Boolean(options?.capture);
}

/** `node`, then its parent, and so on up to the root. */
function* lineage(node: FakeNode): Generator<FakeNode> {
  for (let at: FakeNode | null = node; at; at = at.parentNode) yield at;
}

class FakeEventTarget {
  private readonly listeners = new Map<string, { fn: Listener; capture: boolean }[]>();

  addEventListener(type: string, fn: Listener, options?: ListenerOptions): void {
    const capture = isCapture(options);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((entry) => entry.fn === fn && entry.capture === capture)) {
      list.push({ fn, capture });
    }
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener, options?: ListenerOptions): void {
    const capture = isCapture(options);
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry.fn !== fn || entry.capture !== capture),
    );
  }

  /** This target's listeners for one phase of a dispatch. */
  invoke(event: FakeEvent, capture: boolean): void {
    for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
      if (entry.capture === capture) entry.fn.call(this, event);
    }
  }
}

class FakeNode extends FakeEventTarget {
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument | null,
  ) {
    super();
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  /** In the document, as a node still on screen is. */
  get isConnected(): boolean {
    return [...lineage(this)].some((node) => node instanceof FakeDocument);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes.splice(0)) child.parentNode = null;
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value));
  }

  appendChild(child: FakeNode): FakeNode {
    return this.insertBefore(child, null);
  }

  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (before && at < 0) throw new Error("insertBefore: not a child");
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeNode): FakeNode {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("removeChild: not a child");
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }

  getRootNode(): FakeNode {
    const path = [...lineage(this)];
    return path[path.length - 1];
  }

  /** Capture from the root down, then bubble back up, as a browser does. */
  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    const path = [...lineage(this)];
    for (let i = path.length - 1; i >= 0 && !event.propagationStopped; i -= 1) {
      event.currentTarget = path[i];
      event.eventPhase = i === 0 ? 2 : 1;
      path[i].invoke(event, true);
    }
    for (let i = 0; i < path.length && !event.propagationStopped; i += 1) {
      if (i > 0 && !event.bubbles) break;
      event.currentTarget = path[i];
      event.eventPhase = i === 0 ? 2 : 3;
      path[i].invoke(event, false);
    }
    event.currentTarget = null;
    event.eventPhase = 0;
    return !event.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  private value: string;

  constructor(doc: FakeDocument, value: string) {
    super(3, "#text", doc);
    this.value = value;
    doc.texts.push(value);
  }

  get nodeValue(): string {
    return this.value;
  }

  set nodeValue(value: string) {
    this.value = String(value);
    this.ownerDocument?.texts.push(this.value);
  }

  get data(): string {
    return this.value;
  }

  set data(value: string) {
    this.nodeValue = value;
  }

  override get textContent(): string {
    return this.value;
  }

  override set textContent(value: string) {
    this.nodeValue = value ?? "";
  }
}

function fakeStyle(): Record<string, unknown> {
  const custom = new Map<string, string>();
  return {
    setProperty: (name: string, value: string) => void custom.set(name, String(value)),
    removeProperty: (name: string) => {
      custom.delete(name);
      return "";
    },
    getPropertyValue: (name: string) => custom.get(name) ?? "",
  };
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly localName: string;
  readonly style = fakeStyle();
  private readonly attrs = new Map<string, string>();
  /** Plain fields: nothing lays this DOM out, so a scroll offset stays where it is put. */
  scrollTop = 0;
  scrollLeft = 0;

  constructor(
    doc: FakeDocument,
    readonly namespaceURI: string,
    tag: string,
  ) {
    const name = namespaceURI === HTML_NS ? tag.toUpperCase() : tag;
    super(1, name, doc);
    this.tagName = name;
    this.localName = tag;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name, String(value));
  }

  setAttributeNS(_ns: string | null, name: string, value: unknown): void {
    this.setAttribute(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  removeAttributeNS(_ns: string | null, name: string): void {
    this.removeAttribute(name);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  get classList() {
    const read = () => (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const write = (names: string[]) => this.setAttribute("class", names.join(" "));
    return {
      contains: (name: string) => read().includes(name),
      add: (...names: string[]) => write([...new Set([...read(), ...names])]),
      remove: (...names: string[]) => write(read().filter((name) => !names.includes(name))),
      toggle: (name: string, force?: boolean) => {
        const has = read().includes(name);
        const want = force ?? !has;
        if (want !== has) write(want ? [...read(), name] : read().filter((n) => n !== name));
        return want;
      },
    };
  }

  focus(): void {}

  blur(): void {}

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  /** Tag selectors only, which is all this file asks for. */
  closest(selector: string): FakeElement | null {
    const tag = selector.toUpperCase();
    for (const node of lineage(this)) {
      if (node instanceof FakeElement && node.tagName === tag) return node;
    }
    return null;
  }
}

class FakeDocument extends FakeNode {
  /** Every string this document has displayed, in order: the boot view cannot hide in between. */
  readonly texts: string[] = [];
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  defaultView: FakeWindow | null = null;

  constructor() {
    super(9, "#document", null);
    this.documentElement = this.createElement("html");
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  get activeElement(): FakeElement {
    return this.body;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(this, HTML_NS, tag.toLowerCase());
  }

  createElementNS(ns: string, tag: string): FakeElement {
    return new FakeElement(this, ns, tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }
}

class FakeWindow extends FakeEventTarget {
  readonly event = undefined;
  readonly location = { href: "chrome-extension://zunia/popup.html", search: "", hash: "" };
  readonly HTMLIFrameElement = class {};
  readonly setTimeout = globalThis.setTimeout.bind(globalThis);
  readonly clearTimeout = globalThis.clearTimeout.bind(globalThis);
  readonly setInterval = globalThis.setInterval.bind(globalThis);
  readonly clearInterval = globalThis.clearInterval.bind(globalThis);
  readonly requestAnimationFrame = (cb: (time: number) => void) =>
    globalThis.setTimeout(() => cb(Date.now()), 0);
  readonly cancelAnimationFrame = (handle: ReturnType<typeof setTimeout>) =>
    globalThis.clearTimeout(handle);
  readonly matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  readonly getComputedStyle = () => ({ getPropertyValue: () => "" });
  readonly localStorage = memoryStorage();

  constructor(readonly document: FakeDocument) {
    super();
    document.defaultView = this;
  }

  get window(): FakeWindow {
    return this;
  }
}

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, String(value)),
    removeItem: (key: string) => void items.delete(key),
    clear: () => items.clear(),
  };
}

/* -------------------------------------------------------------------------- *
 * The worker, as the popup sees it through browser.runtime
 * -------------------------------------------------------------------------- */

/** The snapshot useExtensionState reads; holding them freezes a refresh mid-flight. */
const SNAPSHOT_READS = ["GET_STATUS", "GET_SETTINGS", "GET_PENDING_APPROVALS", "LIST_PERMISSIONS"];
const NOTICE_READS = ["GET_ACTIVITY", "GET_PROPOSALS", "GET_UNBONDING"];

const STATUS: SessionStatus = {
  hasWallet: true,
  unlocked: true,
  accounts: [
    {
      index: 0,
      name: "Main",
      address: "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu",
      algo: "secp256k1",
    },
  ],
  activeAccountIndex: 0,
  autoLockMs: 15 * 60_000,
};

interface Worker {
  settings: ExtensionSettings;
  /** The optional host access live balances need. */
  hostAccess: boolean;
  /** Every message type the popup sent, in order. */
  calls: string[];
  unexpected: string[];
  held: Set<string>;
  gate: { promise: Promise<void>; open: () => void } | null;
}

let worker: Worker;

/** Answer on a later task, as a message to a real worker does. */
function later<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

function respond(type: string, payload: unknown): unknown {
  switch (type) {
    case "GET_STATUS":
      return STATUS;
    case "GET_SETTINGS":
      return worker.settings;
    case "SET_SETTINGS":
      worker.settings = { ...worker.settings, ...(payload as Partial<ExtensionSettings>) };
      return worker.settings;
    case "GET_PENDING_APPROVALS":
    case "LIST_PERMISSIONS":
    case "LIST_ADDRESS_BOOK":
    case "GET_BALANCES":
    case "GET_ACTIVITY":
    case "GET_PROPOSALS":
    case "GET_UNBONDING":
      return [];
    case "GET_PRICES":
      return {};
    case "GET_ENABLED_CHAINS":
      return ["cosmoshub-4"];
    case "GET_CHAIN_ACCOUNTS":
      return [{ chainId: "cosmoshub-4", address: STATUS.accounts[0].address }];
    case "TOUCH_SESSION":
      return null;
    default:
      worker.unexpected.push(type);
      throw new Error(`the fake worker does not answer ${type}`);
  }
}

function fakeBrowser() {
  const listeners = () => ({ addListener: () => undefined, removeListener: () => undefined });
  return {
    runtime: {
      id: "zunia",
      getURL: (path: string) => `chrome-extension://zunia/${path.replace(/^\//, "")}`,
      getManifest: () => ({
        version: "0.1.3",
        optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS, ...REALTIME_HOST_PERMISSIONS],
      }),
      sendMessage: async (message: { type: string; payload?: unknown }) => {
        worker.calls.push(message.type);
        if (worker.gate && worker.held.has(message.type)) await worker.gate.promise;
        await later(undefined);
        try {
          return { ok: true, data: structuredClone(respond(message.type, message.payload)) };
        } catch (caught) {
          return { ok: false, error: String(caught) };
        }
      },
      connect: () => ({
        onMessage: listeners(),
        onDisconnect: listeners(),
        postMessage: () => undefined,
        disconnect: () => undefined,
      }),
      onMessage: listeners(),
    },
    storage: {
      onChanged: listeners(),
      local: { get: () => later({}), set: () => later(undefined) },
      session: { get: () => later({}), set: () => later(undefined) },
    },
    permissions: {
      contains: (query: { origins?: string[]; permissions?: string[] }) =>
        later(Boolean(query.origins?.length) && worker.hostAccess),
      request: (query: { origins?: string[] }) => {
        if (query.origins?.length) worker.hostAccess = true;
        return later(true);
      },
      remove: () => {
        worker.hostAccess = false;
        return later(true);
      },
    },
  };
}

function hold(types: string[]): void {
  let open = () => undefined as void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  worker.held = new Set(types);
  worker.gate = { promise, open };
}

async function release(): Promise<void> {
  const gate = worker.gate;
  worker.gate = null;
  worker.held = new Set();
  await act(async () => {
    gate?.open();
    await later(undefined);
  });
  await settle();
}

function count(type: string): number {
  return worker.calls.filter((call) => call === type).length;
}

/* -------------------------------------------------------------------------- *
 * Rendering and queries
 * -------------------------------------------------------------------------- */

let doc: FakeDocument;
let root: Root | null = null;
let App: ComponentType;
let createRoot: typeof import("react-dom/client").createRoot;

/** Let the worker answer and React commit what the answers changed, a few rounds deep. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await later(undefined);
    });
  }
}

async function mount(): Promise<void> {
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root?.render(createElement(App)));
  await settle();
}

function elements(): FakeElement[] {
  const out: FakeElement[] = [];
  const visit = (node: FakeNode) => {
    if (node instanceof FakeElement) out.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(doc.body);
  return out;
}

function screenText(): string {
  return doc.body.textContent;
}

function byText(tag: string, text: string): FakeElement | undefined {
  return elements().find(
    (el) => el.localName === tag && el.textContent.trim() === text,
  );
}

function byLabel(label: string): FakeElement | undefined {
  return elements().find((el) => el.getAttribute("aria-label") === label);
}

/** The switch of the settings row titled `title`. */
function switchFor(title: string): FakeElement | undefined {
  const row = byText("span", title)?.closest("label");
  const find = (node: FakeNode): FakeElement | undefined => {
    for (const child of node.childNodes) {
      if (child instanceof FakeElement && child.getAttribute("role") === "switch") return child;
      const hit = find(child);
      if (hit) return hit;
    }
    return undefined;
  };
  return row ? find(row) : undefined;
}

/** The scrolling body of the open screen (ScreenScaffold's content area). */
function scroller(): FakeElement | undefined {
  return elements().find((el) => (el.getAttribute("class") ?? "").includes("overflow-y-auto"));
}

async function click(el: FakeElement | undefined): Promise<void> {
  if (!el) throw new Error("click: no such element");
  await act(async () => {
    el.dispatchEvent(new FakeEvent("click", true, true));
  });
  await settle();
}

async function openNotifications(): Promise<void> {
  await mount();
  await click(byText("button", "Open notifications"));
  expect(byText("h1", "Notifications")).toBeDefined();
}

/** Settings → Notifications, reached here through the list's settings button. */
async function openNotificationSettings(): Promise<void> {
  await openNotifications();
  await click(byLabel("Notification settings"));
  expect(byText("h1", "Notification settings")).toBeDefined();
}

/* -------------------------------------------------------------------------- *
 * Lifecycle
 * -------------------------------------------------------------------------- */

beforeAll(async () => {
  doc = new FakeDocument();
  const win = new FakeWindow(doc);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", win.localStorage);
  vi.stubGlobal("matchMedia", win.matchMedia);
  vi.stubGlobal("getComputedStyle", win.getComputedStyle);
  vi.stubGlobal("requestAnimationFrame", win.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", win.cancelAnimationFrame);
  vi.stubGlobal("browser", fakeBrowser());
  // Loaded after the globals exist, as they would in the popup: React DOM and
  // Radix decide at load time whether they are in a browser.
  ({ createRoot } = await import("react-dom/client"));
  App = (await import("./App")).default;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  worker = {
    settings: structuredClone(DEFAULT_SETTINGS),
    hostAccess: false,
    calls: [],
    unexpected: [],
    held: new Set(),
    gate: null,
  };
});

afterEach(async () => {
  worker.gate?.open();
  await act(async () => root?.unmount());
  root = null;
  for (const child of [...doc.body.childNodes]) doc.body.removeChild(child);
  expect(worker.unexpected).toEqual([]);
});

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

describe("a saved preference applies in place", () => {
  it("shows the boot view while the first snapshot loads (so the checks below can see it)", async () => {
    hold(SNAPSHOT_READS);
    await mount();
    expect(screenText()).toContain("Opening wallet");
    await release();
    expect(screenText()).not.toContain("Opening wallet");
    expect(byText("button", "Open notifications")).toBeDefined();
  });

  it("keeps Notification settings mounted and scrolled while Staking rewards and a Show switch change", async () => {
    await openNotificationSettings();
    const title = byText("h1", "Notification settings");
    const scrolling = scroller();
    expect(scrolling?.textContent).toContain("Staking rewards");
    // Where the 0.1.3 review measured it: a scrolled settings screen.
    if (scrolling) scrolling.scrollTop = 142;
    const daily = byText("button", "Daily");
    expect(daily?.getAttribute("aria-selected")).toBe("false");
    const shown = doc.texts.length;
    const statusReads = count("GET_STATUS");

    // The re-read that follows the save is held, so the screen is checked
    // while it is in flight: that is when the boot view used to replace it.
    hold(SNAPSHOT_READS);
    await click(daily);

    expect(worker.settings.notify.rewards).toBe("daily");
    expect(count("GET_STATUS")).toBe(statusReads + 1);
    expect(screenText()).not.toContain("Opening wallet");
    // The same nodes, not a new screen: nothing unmounted.
    expect(title?.isConnected).toBe(true);
    expect(byText("h1", "Notification settings")).toBe(title);
    expect(scroller()).toBe(scrolling);
    expect(scroller()?.scrollTop).toBe(142);
    // The saved value shows before the re-read lands.
    expect(daily?.getAttribute("aria-selected")).toBe("true");
    expect(screenText()).toContain("Reminds you once a day while rewards are waiting to be claimed.");

    await release();
    expect(byText("h1", "Notification settings")).toBe(title);
    expect(scroller()?.scrollTop).toBe(142);
    expect(daily?.getAttribute("aria-selected")).toBe("true");

    // A switch in the Show group, the review's other case.
    const governance = switchFor("Governance");
    // Off by default: governance is the noisiest kind.
    expect(governance?.getAttribute("aria-checked")).toBe("false");
    hold(SNAPSHOT_READS);
    await click(governance);
    expect(worker.settings.notify.governance).toBe(true);
    expect(screenText()).not.toContain("Opening wallet");
    expect(switchFor("Governance")).toBe(governance);
    expect(governance?.getAttribute("aria-checked")).toBe("true");
    expect(scroller()?.scrollTop).toBe(142);
    await release();

    expect(byText("h1", "Notification settings")).toBe(title);
    expect(scroller()?.scrollTop).toBe(142);
    // Not even for one commit: nothing drew the boot view after the screen opened.
    expect(doc.texts.slice(shown).filter((text) => text.includes("Opening wallet"))).toEqual([]);
  });
});

describe("Notifications says reads are on from the setting and the host access, as Home does", () => {
  it("on a fresh install (setting on, no access) says reads are off and reads nothing", async () => {
    expect(worker.settings.liveBalances).toBe(true);
    await openNotifications();

    expect(screenText()).toContain(
      "Turn on live balances in Preferences to be told about rewards, transfers and votes.",
    );
    expect(screenText()).not.toContain("governance deadlines land here");
    expect(byLabel("Loading notifications")).toBeUndefined();
    for (const type of NOTICE_READS) expect(count(type)).toBe(0);

    // The way out, and Preferences agrees: its artwork switch waits for live balances too.
    await click(byText("button", "Open Preferences"));
    expect(byText("h1", "Preferences")).toBeDefined();
    expect(switchFor("Live balances")?.getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Load artwork and off-chain details")?.hasAttribute("disabled")).toBe(true);
    expect(screenText()).toContain("Turn on live balances first.");
  });

  it("with the access granted, loads the feed and then says what lands there", async () => {
    worker.hostAccess = true;
    await mount();
    hold(NOTICE_READS);
    await click(byText("button", "Open notifications"));

    for (const type of NOTICE_READS) expect(count(type)).toBe(1);
    expect(byLabel("Loading notifications")).toBeDefined();
    expect(screenText()).not.toContain("Turn on live balances");

    await release();
    expect(byLabel("Loading notifications")).toBeUndefined();
    expect(screenText()).toContain(
      "Approvals, claimable rewards and governance deadlines land here.",
    );
    expect(byText("button", "Open Preferences")).toBeUndefined();
  });

  it("turns on as soon as Preferences gets the access, though the setting was already on", async () => {
    await openNotifications();
    await click(byText("button", "Open Preferences"));
    await click(switchFor("Live balances"));
    expect(worker.hostAccess).toBe(true);
    expect(switchFor("Live balances")?.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Load artwork and off-chain details")?.hasAttribute("disabled")).toBe(false);

    await click(byLabel("Back"));
    expect(byText("h1", "Notifications")).toBeDefined();
    for (const type of NOTICE_READS) expect(count(type)).toBe(1);
    expect(screenText()).toContain(
      "Approvals, claimable rewards and governance deadlines land here.",
    );
  });
});
