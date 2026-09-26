/**
 * A small markdown subset for governance proposal text.
 *
 * Cosmos proposals are authored as markdown (and sometimes pasted HTML). This
 * parser is host-side so the popup can render them without a dependency, and
 * so nothing in the text is treated as HTML.
 */

export type MdInline =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "strong"; readonly children: readonly MdInline[] }
  | { readonly type: "em"; readonly children: readonly MdInline[] }
  | { readonly type: "strike"; readonly children: readonly MdInline[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "link"; readonly href: string; readonly children: readonly MdInline[] };

export type MdVoteOption = "yes" | "no" | "veto" | "abstain";

export type MdBlock =
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly children: readonly MdInline[] }
  | { readonly type: "paragraph"; readonly children: readonly MdInline[] }
  | {
      readonly type: "vote";
      readonly option: MdVoteOption;
      readonly children: readonly MdInline[];
    }
  | { readonly type: "list"; readonly ordered: boolean; readonly items: readonly (readonly MdInline[])[] }
  | { readonly type: "quote"; readonly children: readonly MdInline[] }
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "hr" };

const MAX_SOURCE = 40_000;

export function parseMarkdown(source: string): readonly MdBlock[] {
  const text = prepareSource(source);
  if (!text) return [];

  const blocks: MdBlock[] = [];
  const lines = text.split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const fence: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        fence.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", value: fence.join("\n") });
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", children: parseInline(quoted.join(" ")) });
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: MdInline[][] = [];
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index] ?? "")) {
        items.push(parseInline((lines[index] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, "")));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (!next.trim()) break;
      if (/^(#{1,3}\s+|```|>\s?|\s*([-*+]|\d+\.)\s+|[-*_]{3,}\s*$)/.test(next)) break;
      paragraph.push(next);
      index += 1;
    }
    const joined = paragraph.join(" ");
    const vote = voteLeadOf(joined);
    if (vote) {
      blocks.push({
        type: "vote",
        option: vote.option,
        children: parseInline(vote.rest),
      });
    } else {
      blocks.push({ type: "paragraph", children: parseInline(joined) });
    }
  }

  return blocks;
}

/** http(s), and `www.` rewritten to https. Relative and javascript: links are dropped. */
export function safeMarkdownHref(href: string): string | null {
  const value = href.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^www\./i.test(value)) return `https://${value}`;
  return null;
}

const VOTE_LEAD =
  /^(?:\*\*|__)?\s*(YES|NO\s+WITH\s+VETO|NO|ABSTAIN)\s*(?:\*\*|__)?\s*[-–—:]\s*(.*)$/i;

function voteLeadOf(text: string): { option: MdVoteOption; rest: string } | null {
  const match = VOTE_LEAD.exec(text.trim());
  if (!match) return null;
  const raw = (match[1] ?? "").replace(/\s+/g, " ").toUpperCase();
  const option: MdVoteOption | null =
    raw === "YES"
      ? "yes"
      : raw === "NO WITH VETO"
        ? "veto"
        : raw === "ABSTAIN"
          ? "abstain"
          : raw === "NO"
            ? "no"
            : null;
  if (!option) return null;
  return { option, rest: (match[2] ?? "").trim() };
}

function prepareSource(source: string): string {
  let text = source.replace(/\r\n/g, "\n").replace(/\\n/g, "\n");
  if (text.length > MAX_SOURCE) text = text.slice(0, MAX_SOURCE);
  text = decodeEntities(text);
  if (looksLikeHtml(text)) text = htmlToText(text);
  return text.trim();
}

function looksLikeHtml(text: string): boolean {
  return /<\/?(p|div|br|h[1-3]|ul|ol|li|strong|em|a)\b/i.test(text);
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-3]>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<h([1-3])[^>]*>/gi, (_, level: string) => `${"#".repeat(Number(level))} `)
    .replace(/<\/?(ul|ol|div|span)[^>]*>/gi, "\n")
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<\/?(strong|b)>/gi, "**")
    .replace(/<\/?(em|i)>/gi, "*")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseInline(source: string): MdInline[] {
  const out: MdInline[] = [];
  const pattern =
    /(`+)([^`]+?)\1|<((?:https?:\/\/|www\.)[^>\s]+)>|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      pushText(out, source.slice(cursor, match.index));
    }
    if (match[2] !== undefined) {
      out.push({ type: "code", value: match[2] });
    } else if (match[3] !== undefined) {
      pushLink(out, match[3], [{ type: "text", value: match[3] }]);
    } else if (match[4] !== undefined) {
      const href = safeMarkdownHref(match[5] ?? "");
      const label = parseInline(match[4]);
      if (href) out.push({ type: "link", href, children: label });
      else out.push(...label);
    } else if (match[6] !== undefined || match[7] !== undefined) {
      out.push({ type: "strong", children: parseInline(match[6] ?? match[7] ?? "") });
    } else if (match[8] !== undefined) {
      out.push({ type: "strike", children: parseInline(match[8]) });
    } else {
      out.push({ type: "em", children: parseInline(match[9] ?? match[10] ?? "") });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) pushText(out, source.slice(cursor));
  return out;
}

function pushLink(out: MdInline[], raw: string, children: readonly MdInline[]) {
  const href = safeMarkdownHref(trimUrlPunct(raw));
  if (href) out.push({ type: "link", href, children });
  else out.push({ type: "text", value: raw });
}

const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

function pushText(out: MdInline[], value: string) {
  if (!value) return;
  BARE_URL.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_URL.exec(value))) {
    const raw = trimUrlPunct(match[0]);
    const trailing = match[0].slice(raw.length);
    if (match.index > cursor) {
      out.push({ type: "text", value: value.slice(cursor, match.index) });
    }
    pushLink(out, raw, [{ type: "text", value: displayMarkdownHref(raw) }]);
    if (trailing) out.push({ type: "text", value: trailing });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) out.push({ type: "text", value: value.slice(cursor) });
}

function trimUrlPunct(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}

/** Short label for a bare URL: host + a clipped path. */
export function displayMarkdownHref(href: string): string {
  const absolute = safeMarkdownHref(href) ?? href;
  try {
    const url = new URL(absolute);
    const host = url.hostname.replace(/^www\./, "");
    const path = `${url.pathname}${url.search}`.replace(/\/$/, "");
    const shown = path && path !== "/" ? `${host}${path}` : host;
    return shown.length > 42 ? `${shown.slice(0, 39)}…` : shown;
  } catch {
    return href;
  }
}
