"use client";

/**
 * Skeleton base with a subtle shimmer, used for loading states instead of a
 * "Loading..." text; compose shapes via className (height/width/radius).
 */
export function Skeleton({ className = "", style }) {
  return (
    <div
      className={`animate-[foriq-skeleton_2.4s_ease-in-out_infinite] rounded-md bg-foreground/[0.07] ${className}`}
      style={style}
      aria-hidden="true"
    />
  );
}

/** Placeholder shaped like the dashboard card (name, status, KPI grid, peak). */
export function DashboardCardSkeleton() {
  return (
    <div className="h-full overflow-hidden rounded-2xl border border-border/60 bg-card p-5 shadow-card">
      <div className="min-w-0">
        <Skeleton className="h-[15px] w-32" />
        <div className="mt-2 flex items-center gap-1.5">
          <Skeleton className="size-1.5 rounded-full" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="rounded-lg bg-muted/40 px-2.5 py-2">
            <Skeleton className="mx-auto h-2.5 w-8" />
            <Skeleton className="mx-auto mt-1.5 h-4 w-9" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-2.5 h-3 w-40" />
    </div>
  );
}

/** Placeholder for the sensor detail page (title, counter, chart). */
export function DeviceDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl pb-16 pt-1 md:pt-4">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-4 h-7 w-48" />
      <div className="mt-8 flex items-end gap-8">
        <div>
          <Skeleton className="h-3 w-12" />
          <Skeleton className="mt-2 h-11 w-28" />
        </div>
        <div className="pb-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="mt-2 h-7 w-14" />
        </div>
      </div>
      <Skeleton className="mt-10 h-64 w-full rounded-xl" />
    </div>
  );
}

/**
 * Only the chart area of the detail page, for when header/counter already come
 * from the seed cache and just the chart (own endpoint) is still loading.
 */
export function ChartSkeleton() {
  return <Skeleton className="h-64 w-full rounded-xl" />;
}

/** Table row placeholder (e.g. hit lists). */
export function TableRowsSkeleton({ rows = 8 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}
