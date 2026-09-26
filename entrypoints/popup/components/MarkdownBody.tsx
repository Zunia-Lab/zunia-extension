import type { ReactNode } from "react";
import { cn, focusRing } from "@zunialab/ui";
import {
  parseMarkdown,
  type MdBlock,
  type MdInline,
  type MdVoteOption,
} from "../../../lib/markdown";

const VOTE_TONE: Record<MdVoteOption, { label: string; className: string }> = {
  yes: {
    label: "Yes",
    className:
      "border-[color-mix(in_srgb,var(--z-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--z-accent)_8%,transparent)]",
  },
  no: { label: "No", className: "border-[var(--z-line-strong)]" },
  veto: { label: "No with veto", className: "border-[color-mix(in_srgb,var(--z-danger)_35%,transparent)]" },
  abstain: { label: "Abstain", className: "border-[var(--z-line)]" },
};

/**
 * Governance proposal body. Headings become the same section labels the rest
 * of the popup uses; links stay http(s) only and open outside the extension.
 */
export function MarkdownBody({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;

  return (
    <article
      className={cn("flex min-w-0 max-w-full flex-col gap-3 overflow-hidden", className)}
    >
      {blocks.map((block, index) => (
        <Block key={`${block.type}-${index}`} block={block} />
      ))}
    </article>
  );
}

function Block({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading":
      return <Heading level={block.level}>{renderInline(block.children)}</Heading>;
    case "paragraph":
      return (
        <p className="m-0 min-w-0 max-w-full break-words text-[12.5px] leading-[1.55] text-fg-muted [overflow-wrap:anywhere]">
          {renderInline(block.children)}
        </p>
      );
    case "vote": {
      const tone = VOTE_TONE[block.option];
      return (
        <div className={cn("min-w-0 overflow-hidden rounded-[12px] border px-3 py-2", tone.className)}>
          <p className="m-0 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg">
            {tone.label}
          </p>
          <p className="m-0 mt-1 min-w-0 break-words text-[12.5px] leading-[1.55] text-fg-muted [overflow-wrap:anywhere]">
            {renderInline(block.children)}
          </p>
        </div>
      );
    }
    case "quote":
      return (
        <blockquote className="m-0 min-w-0 break-words border-l-2 border-accent pl-2.5 text-[12.5px] leading-[1.55] text-fg-muted [overflow-wrap:anywhere]">
          {renderInline(block.children)}
        </blockquote>
      );
    case "list":
      return block.ordered ? (
        <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-2 text-[12.5px] leading-[1.55] text-fg-muted">
              <span className="w-4 shrink-0 font-mono text-[10px] text-fg-dim">
                {index + 1}.
              </span>
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {renderInline(item)}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {block.items.map((item, index) => (
            <li key={index} className="flex gap-2 text-[12.5px] leading-[1.55] text-fg-muted">
              <span
                aria-hidden
                className="mt-[7px] size-1 shrink-0 rounded-full bg-accent"
              />
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {renderInline(item)}
              </span>
            </li>
          ))}
        </ul>
      );
    case "code":
      return (
        <pre className="m-0 max-w-full whitespace-pre-wrap break-all rounded-[12px] border border-[var(--z-line)] bg-[var(--z-glass)] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-fg">
          {block.value}
        </pre>
      );
    case "hr":
      return <hr className="m-0 border-0 border-t border-[var(--z-line)]" />;
  }
}

function Heading({
  level,
  children,
}: {
  level: 1 | 2 | 3;
  children: ReactNode;
}) {
  if (level === 1) {
    return (
      <h3 className="m-0 break-words text-[15px] font-medium leading-snug tracking-[-0.02em] text-fg [overflow-wrap:anywhere]">
        {children}
      </h3>
    );
  }
  if (level === 2) {
    return (
      <h4 className="m-0 font-mono text-[9.5px] font-normal uppercase tracking-[0.16em] text-fg-dim">
        {children}
      </h4>
    );
  }
  return (
    <h5 className="m-0 break-words text-[13px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
      {children}
    </h5>
  );
}

function renderInline(nodes: readonly MdInline[]): ReactNode {
  return nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text":
        return <span key={key}>{node.value}</span>;
      case "strong":
        return (
          <strong key={key} className="font-medium text-fg">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return (
          <em key={key} className="italic text-fg-muted">
            {renderInline(node.children)}
          </em>
        );
      case "strike":
        return (
          <s key={key} className="text-fg-dim">
            {renderInline(node.children)}
          </s>
        );
      case "code":
        return (
          <code
            key={key}
            className="break-all rounded-[6px] bg-[var(--z-glass-2)] px-1 py-0.5 font-mono text-[11px] text-fg"
          >
            {node.value}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "break-all text-accent underline decoration-[color-mix(in_srgb,var(--z-accent)_35%,transparent)] underline-offset-2",
              "hover:decoration-accent",
              focusRing,
            )}
          >
            {renderInline(node.children)}
          </a>
        );
    }
  });
}
