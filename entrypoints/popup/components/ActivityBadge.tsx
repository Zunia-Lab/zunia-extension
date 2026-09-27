import {
  activityPresentation,
  cn,
  messageActivityGlyph,
  type ActivityKind,
  type ActivityTone,
} from "@zunialab/ui";

const INFO =
  "border-[var(--z-info-line)] bg-[var(--z-info-fill)] text-[var(--z-info)]";
const SUCCESS =
  "border-[var(--z-success-line)] bg-[var(--z-success-fill)] text-[var(--z-success)]";
const DANGER =
  "border-[var(--z-danger-line)] bg-[var(--z-danger-fill)] text-[var(--z-danger)]";

const TONE_CLASS: Record<ActivityTone, string> = {
  send: DANGER,
  receive: SUCCESS,
  ibc: INFO,
  swap: "border-[color-mix(in_srgb,var(--z-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--z-accent)_18%,transparent)] text-accent",
  stake: INFO,
  claim: SUCCESS,
  vote: INFO,
  muted: "border-[var(--z-line)] bg-[var(--z-glass-2)] text-fg-muted",
  danger: DANGER,
};

/**
 * The round glyph at the start of a history row. Named for screen readers
 * unless `decorative`, when the row text already says what happened.
 */
export function ActivityBadge({
  kind,
  messageType,
  success = true,
  decorative = false,
  className,
}: {
  kind: ActivityKind | string | undefined;
  /** Protobuf name, so a type with no activity kind still has a glyph. */
  messageType?: string;
  success?: boolean;
  decorative?: boolean;
  className?: string;
}) {
  const presentation = activityPresentation(kind, success);
  // A send, swap, or stake already has its own mark. The type glyph fills the
  // blank circle used for everything else, including types we do not describe.
  const typed =
    success && presentation.kind === "other" ? messageActivityGlyph(messageType) : null;
  const tone = typed?.tone ?? presentation.tone;
  const icon = typed?.icon ?? presentation.icon;
  const label = typed?.label ?? presentation.label;
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border text-[15px] font-semibold leading-none",
        TONE_CLASS[tone],
        className,
      )}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      {icon}
    </span>
  );
}
