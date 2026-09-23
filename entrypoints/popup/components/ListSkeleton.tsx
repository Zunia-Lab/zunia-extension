import { Skeleton, cn } from "@zunialab/ui";

/**
 * Placeholder rows shaped like the list that is loading, so the layout does
 * not jump when the data lands. Announced once as a busy status.
 */
export function ListSkeleton({
  rows = 3,
  label = "Loading",
  avatar = true,
  className,
}: {
  rows?: number;
  label?: string;
  /** Leading circle, for rows that show a logo or an avatar. */
  avatar?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className={cn("flex flex-col gap-1", className)}
    >
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-2.5 rounded-[12px] px-2 py-2.5">
          {avatar ? <Skeleton className="size-8 shrink-0 rounded-full" /> : null}
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={row % 2 ? "h-2.5 w-1/3" : "h-2.5 w-1/2"} />
            <Skeleton className="h-2 w-1/4" />
          </div>
          <Skeleton className="h-2.5 w-12 shrink-0" />
        </div>
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
        <div key={tile} className="flex flex-col gap-2">
          <Skeleton className="aspect-square h-auto w-full rounded-[14px]" />
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      ))}
    </div>
  );
}
