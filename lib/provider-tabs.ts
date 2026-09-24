import { STORAGE_KEYS } from "./storage-keys";

/**
 * Which tab shows which site, learned from the provider calls its page makes.
 *
 * Browsers only tell an extension a tab's URL with the tabs permission, which
 * would expose every page the user visits. The pages that talk to the provider
 * are the only ones wallet events are for, so they are the ones remembered.
 * Kept in storage.session, which pages cannot read, so a worker restart does
 * not leave open dApps without events.
 */
type TabOrigins = Record<string, string>;

let cache: TabOrigins | null = null;
let loading: Promise<TabOrigins> | null = null;
let writing: Promise<unknown> = Promise.resolve();

function load(): Promise<TabOrigins> {
  if (cache) return Promise.resolve(cache);
  loading ??= browser.storage.session
    .get(STORAGE_KEYS.providerTabs)
    .then((stored) => {
      const raw = stored[STORAGE_KEYS.providerTabs];
      const tabs: TabOrigins = {};
      if (raw && typeof raw === "object") {
        for (const [tabId, origin] of Object.entries(raw)) {
          if (typeof origin === "string") tabs[tabId] = origin;
        }
      }
      return tabs;
    })
    .catch(() => ({}))
    .then((tabs) => (cache ??= tabs));
  return loading;
}

function persist(tabs: TabOrigins): void {
  const snapshot = { ...tabs };
  writing = writing
    .then(() => browser.storage.session.set({ [STORAGE_KEYS.providerTabs]: snapshot }))
    .catch(() => undefined);
}

export async function rememberProviderTab(tabId: number, origin: string): Promise<void> {
  const tabs = await load();
  if (tabs[tabId] === origin) return;
  tabs[tabId] = origin;
  persist(tabs);
}

export async function forgetProviderTab(tabId: number): Promise<void> {
  const tabs = await load();
  if (!(tabId in tabs)) return;
  delete tabs[tabId];
  persist(tabs);
}

/** Tabs whose page last made provider calls from `origin`. */
export async function providerTabsFor(origin: string): Promise<number[]> {
  const tabs = await load();
  return Object.entries(tabs)
    .filter(([, tabOrigin]) => tabOrigin === origin)
    .map(([tabId]) => Number(tabId));
}

/** Test-only reset. */
export function resetProviderTabsForTests(): void {
  cache = null;
  loading = null;
  writing = Promise.resolve();
}
