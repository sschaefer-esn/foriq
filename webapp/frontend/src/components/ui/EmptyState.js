"use client";

/**
 * Uniform empty state: icon, title, optional subtext and an action slot.
 * Replaces bare "no data" texts with a calm, tidy picture.
 */
export default function EmptyState({ icon: Icon, title, subtitle, action, className = "" }) {
  return (
    <div
      className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-card/40 px-6 py-10 text-center ${className}`}
    >
      {Icon && <Icon className="size-8 text-muted-foreground/50" strokeWidth={1.5} />}
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      {subtitle && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
