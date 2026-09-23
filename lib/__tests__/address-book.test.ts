import { describe, expect, it } from "vitest";
import {
  addContact,
  contactAddressProblem,
  contactsFor,
  migrateAddressBook,
  recentContacts,
  removeContact,
  sortContacts,
  suggestedContacts,
  toggleContactFavorite,
  touchContact,
  updateContact,
  type AddressBookEntry,
  type PrefixLookup,
} from "../address-book";
import { isBech32, prefixOf } from "../format";

const HUB = "cosmos1qyyq79says4nyw2qga892hrrdfchsluxcqtzp4";
const HUB_2 = "cosmos1qgy3q9c7y5krxwjpfp84vhtydde8nqy8x5y8qg";
const OSMO = "osmo1qyyq79says4nyw2qga892hrrdfchsluxsmcjh8";
const SAFRO = "addr_safro1qyyq79says4nyw2qga892hrrdfchsluxqv2429";
/** HUB with its last character changed: right shape, wrong checksum. */
const HUB_TYPO = "cosmos1qyyq79says4nyw2qga892hrrdfchsluxcqtzp5";

const prefixes: Record<string, string> = {
  "cosmoshub-4": "cosmos",
  "osmosis-1": "osmo",
  "safrochain-1": "addr_safro",
};
const prefixFor: PrefixLookup = (chainId) => prefixes[chainId];

function book(): AddressBookEntry[] {
  let rows: AddressBookEntry[] = [];
  rows = addContact(rows, { label: "Treasury", address: HUB }, { now: 1, id: "a", prefixFor });
  rows = addContact(
    rows,
    { label: "Exchange", address: OSMO, chainId: "osmosis-1" },
    { now: 2, id: "b", prefixFor },
  );
  return rows;
}

describe("address validation", () => {
  it("checks the checksum, not only the shape", () => {
    expect(isBech32(HUB)).toBe(true);
    expect(isBech32(HUB_TYPO)).toBe(false);
    expect(contactAddressProblem(HUB_TYPO, undefined, prefixFor)).toMatch(/typo/);
  });

  it("accepts prefixes with an underscore and reads the prefix before the last 1", () => {
    expect(isBech32(SAFRO)).toBe(true);
    expect(prefixOf(SAFRO)).toBe("addr_safro");
  });

  it("refuses mixed or upper case", () => {
    expect(isBech32(HUB.toUpperCase())).toBe(false);
  });

  it("requires the chosen network's exact prefix", () => {
    expect(contactAddressProblem(HUB, "osmosis-1", prefixFor)).toBe(
      "That network uses osmo1… addresses",
    );
    expect(contactAddressProblem(OSMO, "osmosis-1", prefixFor)).toBeNull();
    expect(contactAddressProblem(HUB, "unknown-1", prefixFor)).toBeNull();
    expect(contactAddressProblem("  ", undefined, prefixFor)).toBe("Enter an address");
  });
});

describe("addContact", () => {
  it("saves a trimmed contact with neutral counters", () => {
    const [row] = addContact(
      [],
      { label: "  Treasury  ", address: ` ${HUB} `, note: "  cold  " },
      { now: 10, id: "x", prefixFor },
    );
    expect(row).toEqual({
      id: "x",
      label: "Treasury",
      address: HUB,
      note: "cold",
      favorite: false,
      useCount: 0,
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it("refuses a missing name, a bad address and a duplicate", () => {
    expect(() => addContact([], { label: " ", address: HUB }, { prefixFor })).toThrow(/name/);
    expect(() => addContact([], { label: "A", address: HUB_TYPO }, { prefixFor })).toThrow(
      /typo/,
    );
    expect(() =>
      addContact(book(), { label: "Again", address: HUB }, { prefixFor }),
    ).toThrow("That address is already saved as Treasury");
  });
});

describe("updateContact", () => {
  it("edits fields, keeps the counters and stamps updatedAt", () => {
    const touched = touchContact(book(), HUB, 50);
    const next = updateContact(
      touched,
      "a",
      { label: "Ops", note: "multisig", chainId: "cosmoshub-4" },
      { now: 99, prefixFor },
    );
    const row = next.find((entry) => entry.id === "a");
    expect(row).toMatchObject({
      label: "Ops",
      note: "multisig",
      chainId: "cosmoshub-4",
      useCount: 1,
      lastUsedAt: 50,
      createdAt: 1,
      updatedAt: 99,
    });
  });

  it("clears optional fields with null", () => {
    const next = updateContact(book(), "b", { chainId: null, note: null }, { prefixFor });
    expect(next.find((entry) => entry.id === "b")).not.toHaveProperty("chainId");
  });

  it("validates the address against the network it ends up on", () => {
    expect(() => updateContact(book(), "b", { address: HUB_2 }, { prefixFor })).toThrow(
      "That network uses osmo1… addresses",
    );
    expect(() =>
      updateContact(book(), "b", { address: HUB, chainId: null }, { prefixFor }),
    ).toThrow(/already saved as Treasury/);
    expect(() => updateContact(book(), "missing", { label: "X" }, { prefixFor })).toThrow(
      /no longer exists/,
    );
  });
});

describe("remove, favorite and touch", () => {
  it("removes by id", () => {
    expect(removeContact(book(), "a").map((row) => row.id)).toEqual(["b"]);
  });

  it("toggles the favorite flag", () => {
    const once = toggleContactFavorite(book(), "a", 5);
    expect(once.find((row) => row.id === "a")).toMatchObject({ favorite: true, updatedAt: 5 });
    const twice = toggleContactFavorite(once, "a", 6);
    expect(twice.find((row) => row.id === "a")?.favorite).toBe(false);
  });

  it("counts sends to saved addresses and ignores the rest", () => {
    const rows = touchContact(touchContact(book(), OSMO, 7), OSMO, 8);
    expect(rows.find((row) => row.id === "b")).toMatchObject({ useCount: 2, lastUsedAt: 8 });
    expect(touchContact(rows, HUB_2, 9)).toEqual(rows);
  });
});

describe("views", () => {
  it("offers only contacts for the target prefix and network", () => {
    const rows = book();
    expect(contactsFor(rows, { prefix: "osmo", chainId: "osmosis-1" }).map((r) => r.id)).toEqual([
      "b",
    ]);
    // Pinned to osmosis-1, so a testnet with the same prefix does not see it.
    expect(contactsFor(rows, { prefix: "osmo", chainId: "osmo-test-5" })).toEqual([]);
    expect(contactsFor(rows, { prefix: "cosmos", chainId: "cosmoshub-4" }).map((r) => r.id)).toEqual(
      ["a"],
    );
  });

  it("lists recent contacts newest first, then suggests favorites before them", () => {
    let rows = book();
    rows = addContact(rows, { label: "Alice", address: HUB_2 }, { now: 3, id: "c", prefixFor });
    rows = touchContact(rows, HUB, 10);
    rows = touchContact(rows, OSMO, 20);
    rows = toggleContactFavorite(rows, "c", 30);
    expect(recentContacts(rows).map((row) => row.id)).toEqual(["b", "a"]);
    expect(suggestedContacts(rows).map((row) => row.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by name without regard to case", () => {
    const rows = addContact(book(), { label: "alpha", address: HUB_2 }, { prefixFor });
    expect(sortContacts(rows).map((row) => row.label)).toEqual(["alpha", "Exchange", "Treasury"]);
  });
});

describe("migrateAddressBook", () => {
  it("upgrades first-version rows", () => {
    const rows = migrateAddressBook(
      [{ id: "old", label: "Treasury", address: HUB, chainId: "cosmoshub-4", createdAt: 5 }],
      100,
    );
    expect(rows).toEqual([
      {
        id: "old",
        label: "Treasury",
        address: HUB,
        chainId: "cosmoshub-4",
        favorite: false,
        useCount: 0,
        createdAt: 5,
        updatedAt: 5,
      },
    ]);
  });

  it("keeps current rows as they are", () => {
    const current = touchContact(toggleContactFavorite(book(), "a", 4), HUB, 6);
    expect(migrateAddressBook(current)).toEqual(current);
  });

  it("drops unusable rows, repairs ids and labels, and keeps bad checksums visible", () => {
    const rows = migrateAddressBook(
      [
        null,
        "text",
        { label: "No address" },
        { id: "dup", label: "One", address: HUB, createdAt: 1 },
        { id: "dup", label: "", address: HUB_TYPO, createdAt: 2, useCount: -3, favorite: "yes" },
      ],
      100,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("dup");
    expect(rows[1]?.id).not.toBe("dup");
    expect(rows[1]).toMatchObject({
      label: HUB_TYPO.slice(0, 40),
      address: HUB_TYPO,
      favorite: false,
      useCount: 0,
    });
  });

  it("reads anything that is not a list as empty", () => {
    expect(migrateAddressBook(undefined)).toEqual([]);
    expect(migrateAddressBook({ rows: [] })).toEqual([]);
  });
});
