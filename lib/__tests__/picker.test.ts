import { describe, expect, it } from "vitest";
import {
  EMPTY_PICKER_MEMORY,
  MAX_RECENTS,
  pickerSections,
  readPickerMemory,
  rememberRecent,
  searchItems,
  toggleFavorite,
} from "../picker";

const chains = [
  { id: "cosmoshub-4", label: "Cosmos Hub", sublabel: "ATOM", keywords: ["cosmos"] },
  { id: "osmosis-1", label: "Osmosis", sublabel: "OSMO", keywords: ["osmo"] },
  { id: "juno-1", label: "Juno", sublabel: "JUNO", keywords: ["juno"] },
  { id: "stargaze-1", label: "Stargaze", sublabel: "STARS", keywords: ["stars"] },
  { id: "neutron-1", label: "Neutron", sublabel: "NTRN", keywords: ["neutron"] },
];

describe("searchItems", () => {
  it("returns everything, in order, for an empty query", () => {
    expect(searchItems(chains, "   ").map((c) => c.id)).toEqual(chains.map((c) => c.id));
  });

  it("puts label prefix matches before other matches", () => {
    const ids = searchItems(chains, "o").map((c) => c.id);
    expect(ids[0]).toBe("osmosis-1");
    expect(ids).toContain("cosmoshub-4");
  });

  it("requires every word to match somewhere", () => {
    expect(searchItems(chains, "cosmos atom").map((c) => c.id)).toEqual(["cosmoshub-4"]);
    expect(searchItems(chains, "juno osmo")).toEqual([]);
  });

  it("matches sublabels and keywords without case or accents", () => {
    expect(searchItems(chains, "STARS").map((c) => c.id)).toEqual(["stargaze-1"]);
    expect(searchItems([{ id: "x", label: "Évmos" }], "evm").map((c) => c.id)).toEqual(["x"]);
  });
});

describe("pickerSections", () => {
  it("lists favorites, then recents without the favorites, then the rest once", () => {
    const sections = pickerSections(chains, {
      query: "",
      favorites: ["juno-1"],
      recents: ["juno-1", "osmosis-1", "gone-1"],
    });
    expect(sections.map((s) => s.key)).toEqual(["favorites", "recents", "all"]);
    expect(sections[0]!.items.map((c) => c.id)).toEqual(["juno-1"]);
    expect(sections[1]!.items.map((c) => c.id)).toEqual(["osmosis-1"]);
    expect(sections[2]!.items.map((c) => c.id)).toEqual([
      "cosmoshub-4",
      "stargaze-1",
      "neutron-1",
    ]);
  });

  it("omits All when every network is already in Favorites or Recent", () => {
    const sections = pickerSections(chains.slice(0, 2), {
      query: "",
      favorites: ["cosmoshub-4"],
      recents: ["osmosis-1"],
    });
    expect(sections.map((s) => s.key)).toEqual(["favorites", "recents"]);
  });

  it("shows only the untitled full list when nothing is remembered", () => {
    const sections = pickerSections(chains, { query: "" });
    expect(sections).toHaveLength(1);
    expect(sections[0]!.title).toBe("");
  });

  it("switches to a single ranked result list while searching", () => {
    const sections = pickerSections(chains, { query: "neu", favorites: ["juno-1"] });
    expect(sections.map((s) => s.key)).toEqual(["results"]);
    expect(sections[0]!.items.map((c) => c.id)).toEqual(["neutron-1"]);
  });
});

describe("picker memory", () => {
  it("keeps recents unique, newest first, and bounded", () => {
    let memory = EMPTY_PICKER_MEMORY;
    for (const id of ["a", "b", "c", "a", "d", "e", "f", "g"]) memory = rememberRecent(memory, id);
    expect(memory.recents).toHaveLength(MAX_RECENTS);
    expect(memory.recents[0]).toBe("g");
    expect(memory.recents.filter((id) => id === "a")).toHaveLength(1);
  });

  it("toggles favorites on and off", () => {
    const on = toggleFavorite(EMPTY_PICKER_MEMORY, "osmosis-1");
    expect(on.favorites).toEqual(["osmosis-1"]);
    expect(toggleFavorite(on, "osmosis-1").favorites).toEqual([]);
  });

  it("drops malformed stored values instead of throwing", () => {
    expect(readPickerMemory(null)).toEqual({});
    expect(readPickerMemory(["chain"])).toEqual({});
    expect(
      readPickerMemory({
        chain: { favorites: ["a", 3, "a", ""], recents: "b" },
        token: null,
      }),
    ).toEqual({
      chain: { favorites: ["a"], recents: [] },
      token: { favorites: [], recents: [] },
    });
  });
});
