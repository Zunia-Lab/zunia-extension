import { Skeleton, cn } from "@zunialab/ui";

/**
 * Placeholder rows shaped like the list that is loading, so the layout does
 * not jump when the data lands. Announced once as a busy status.
 */
export function ListSkeleton({
  rows = 3,
  label = "Loading",
  avatar = true,
  bordered = false,
  className,
}: {
  rows?: number;
  label?: string;
  /** Leading circle, for rows that show a logo or an avatar. */
  avatar?: boolean;
  /** Match bordered list cards (stake, notices) instead of flush home rows. */
  bordered?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col", bordered ? "gap-1.5" : "gap-1", className)}
    >
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className={cn(
            "flex items-center gap-2.5",
            bordered
              ? "rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5"
              : "rounded-[12px] px-2 py-2.5",
          )}
        >
          {avatar ? <Skeleton className="size-8 shrink-0 rounded-full" /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={row % 2 ? "h-2.5 w-1/3" : "h-2.5 w-1/2"} />
            <Skeleton className="h-2 w-1/4" />
          </div>
          <Skeleton className="h-2.5 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** Taller cards: proposals, with an optional tally bar. */
export function CardSkeleton({
  rows = 3,
  label = "Loading",
  tally = false,
  className,
}: {
  rows?: number;
  label?: string;
  tally?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col gap-2", className)}
    >
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="rounded-[14px] border border-[var(--z-line)] px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-2 w-1/3" />
            <Skeleton className="h-4 w-12 rounded-full" />
          </div>
          <Skeleton className={cn("mt-2 h-2.5", row % 2 ? "w-3/5" : "w-4/5")} />
          <Skeleton className="mt-1.5 h-2.5 w-1/2" />
          {tally ? <Skeleton className="mt-2.5 h-1.5 w-full rounded-full" /> : null}
          <Skeleton className="mt-2 h-2 w-1/4" />
        </div>
      ))}
    </div>
  );
}

/** Large amount in a hero, like Home total or Earn staked. */
export function HeroSkeleton({
  label = "Loading",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col gap-2", className)}
    >
      <Skeleton className="h-8 w-36 rounded-[10px]" />
      <Skeleton className="h-2 w-16" />
    </div>
  );
}

/** Horizontal filter chips, matching All / network / kind pills. */
export function ChipSkeleton({
  chips = 4,
  label = "Loading filters",
  className,
}: {
  chips?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("-mx-1 flex gap-1 overflow-hidden px-1 pb-0.5", className)}
    >
      {Array.from({ length: chips }, (_, chip) => (
        <Skeleton
          key={chip}
          className={cn(
            "h-6 shrink-0 rounded-full",
            chip === 0 ? "w-10" : chip % 2 ? "w-[72px]" : "w-16",
          )}
        />
      ))}
    </div>
  );
}

/** Placeholder for a grid of square tiles, like the NFT gallery. */
export function TileSkeleton({
  tiles = 4,
  label = "Loading",
  className,
}: {
  tiles?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("grid grid-cols-2 gap-2.5", className)}
    >
      {Array.from({ length: tiles }, (_, tile) => (
        <div
          key={tile}
          className="rounded-[14px] border border-[var(--z-line)] p-2"
        >
          <Skeleton className="aspect-square h-auto w-full rounded-[12px]" />
          <Skeleton className="mt-2 h-2.5 w-2/3" />
          <Skeleton className="mt-1.5 h-2 w-1/2" />
        </div>
      ))}
    </div>
  );
}

/** Collection heading plus a tile grid, the shape the NFT list actually uses. */
export function NftGallerySkeleton({
  collections = 1,
  tiles = 4,
  label = "Asking each collection",
  className,
}: {
  collections?: number;
  tiles?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col gap-3", className)}
    >
      {Array.from({ length: collections }, (_, collection) => (
        <section key={collection} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-2.5 w-2/5" />
              <Skeleton className="h-2 w-1/3" />
            </span>
            <Skeleton className="h-4 w-12 shrink-0 rounded-full" />
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {Array.from({ length: tiles }, (_, tile) => (
              <div
                key={tile}
                className="rounded-[14px] border border-[var(--z-line)] p-2"
              >
                <Skeleton className="aspect-square h-auto w-full rounded-[12px]" />
                <Skeleton className="mt-2 h-2.5 w-2/3" />
                <Skeleton className="mt-1.5 h-2 w-1/2" />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
