import { describe, expect, it } from "vitest";
import { parseMarkdown, safeMarkdownHref } from "../markdown";

describe("parseMarkdown", () => {
  it("turns ## headings into section blocks", () => {
    const [heading] = parseMarkdown("## Motivation\n\nShip the change.");
    expect(heading).toMatchObject({ type: "heading", level: 2 });
  });

  it("parses lists, emphasis and links", () => {
    const blocks = parseMarkdown(
      "- **Yes** on [forum](https://forum.cosmos.network/t/1)\n- skip `MsgVote`",
    );
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    if (blocks[0]?.type !== "list") throw new Error("expected list");
    expect(blocks[0].items[0]?.some((node) => node.type === "strong")).toBe(true);
    expect(blocks[0].items[0]?.some((node) => node.type === "link")).toBe(true);
    expect(blocks[0].items[1]?.some((node) => node.type === "code")).toBe(true);
  });

  it("keeps fenced code and drops javascript links", () => {
    const blocks = parseMarkdown(
      "See [x](javascript:alert(1))\n\n```\nmsg\n```",
    );
    expect(blocks[0]).toMatchObject({ type: "paragraph" });
    if (blocks[0]?.type !== "paragraph") throw new Error("expected paragraph");
    expect(blocks[0].children.some((node) => node.type === "link")).toBe(false);
    expect(blocks[1]).toMatchObject({ type: "code", value: "msg" });
  });

  it("flattens common HTML proposal paste", () => {
    const blocks = parseMarkdown("<h2>Summary</h2><p>Raise the <strong>cap</strong>.</p>");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ type: "paragraph" });
  });
});

describe("safeMarkdownHref", () => {
  it("allows http(s) and rejects the rest", () => {
    expect(safeMarkdownHref("https://cosmos.network")).toBe("https://cosmos.network");
    expect(safeMarkdownHref("www.cosmos.network")).toBe("https://www.cosmos.network");
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(safeMarkdownHref("/local")).toBeNull();
  });
});

describe("proposal formatting", () => {
  it("turns YES / NO / VETO / ABSTAIN leads into vote blocks", () => {
    const blocks = parseMarkdown(
      "YES - You agree.\n\nNO - You disagree.\n\nNO WITH VETO - A `NoWithVeto` vote.\n\nABSTAIN - You sit out.",
    );
    expect(blocks.map((block) => block.type)).toEqual(["vote", "vote", "vote", "vote"]);
    expect(blocks[0]).toMatchObject({ type: "vote", option: "yes" });
    expect(blocks[2]).toMatchObject({ type: "vote", option: "veto" });
  });

  it("autolinks bare https urls", () => {
    const [block] = parseMarkdown("Read https://forum.cosmos.network/t/10555 for the note.");
    expect(block).toMatchObject({ type: "paragraph" });
    if (block?.type !== "paragraph") throw new Error("expected paragraph");
    const link = block.children.find((node) => node.type === "link");
    expect(link).toMatchObject({
      type: "link",
      href: "https://forum.cosmos.network/t/10555",
    });
  });

  it("does not italicize identifiers that contain underscores", () => {
    const [block] = parseMarkdown("Use NO_WITH_VETO on chain.");
    expect(block).toMatchObject({ type: "paragraph" });
    if (block?.type !== "paragraph") throw new Error("expected paragraph");
    expect(block.children.some((node) => node.type === "em")).toBe(false);
  });
});
