"use client";

import { Check, CheckCircle2, Loader2, Server, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const COPY = {
  saved: {
    titleKey: "devices.pending.saved.title",
    detailKey: "devices.pending.saved.detail",
    icon: Check,
    tone: "text-primary",
    surface: "border-primary/25 bg-primary/[0.04]",
  },
  waiting: {
    titleKey: "devices.pending.waiting.title",
    detailKey: "devices.pending.waiting.detail",
    icon: Loader2,
    tone: "text-amber-600 dark:text-amber-400",
    surface: "border-amber-500/30 bg-amber-500/[0.07]",
  },
  applied: {
    titleKey: "devices.pending.applied.title",
    detailKey: "devices.pending.applied.detail",
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    surface: "border-emerald-500/25 bg-emerald-500/[0.06]",
  },
  error: {
    titleKey: "devices.pending.error.title",
    detailKey: "devices.pending.error.detail",
    icon: TriangleAlert,
    tone: "text-destructive",
    surface: "border-destructive/30 bg-destructive/[0.06]",
  },
  idle: {
    titleKey: "devices.pending.idle.title",
    detailKey: "devices.pending.idle.detail",
    icon: Server,
    tone: "text-muted-foreground",
    surface: "border-border/60 bg-muted/20",
  },
};

export default function PendingSettingsBreadcrumb({ status, onDismiss, showIdle = false }) {
  const t = useT();
  const phase = status?.phase || "idle";
  if (phase === "idle" && !showIdle) return null;

  const copy = COPY[phase] || COPY.idle;
  const Icon = copy.icon;
  const count = status?.count || 0;
  const canDismiss = (phase === "applied" || phase === "error") && onDismiss;
  const detail = status?.message || t(copy.detailKey);

  return (
    <div
      role={phase === "error" ? "alert" : "status"}
      aria-live={phase === "error" ? "assertive" : "polite"}
      className={cn("flex min-h-14 items-center gap-3 rounded-lg border px-3.5 py-2.5", copy.surface)}
    >
      <Icon className={cn("size-4 shrink-0", copy.tone, phase === "waiting" && "animate-spin")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <p className="text-sm font-medium leading-5">{t(copy.titleKey)}</p>
          {count > 1 && <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{t("devices.pending.paramCount", { count })}</span>}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </div>
      <div className="hidden shrink-0 items-center gap-1.5 font-mono text-[9px] tracking-[0.12em] text-muted-foreground sm:flex" aria-hidden="true">
        <span className={phase !== "idle" ? copy.tone : ""}>SERVER</span>
        <span className="h-px w-5 bg-border" />
        <span className={phase === "applied" ? copy.tone : ""}>SENSOR</span>
      </div>
      {canDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("devices.pending.dismiss")}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
