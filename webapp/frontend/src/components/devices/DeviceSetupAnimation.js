"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Magnet,
  Sparkles,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { useT } from "@/lib/i18n";

// Setup view for a freshly added sensor (status "provisioning").
// Plain spinner + note that the sensor is being set up, plus a carousel of
// mounting/usage tips to bridge the 2–3 minutes until it first comes online.
// Once the sensor sends for the first time, deviceStatus() leaves "provisioning"
// and this component disappears automatically.

const TIPS = [
  { icon: MapPin, titleKey: "devices.setup.tip.location.title", textKey: "devices.setup.tip.location.text" },
  { icon: Magnet, titleKey: "devices.setup.tip.mount.title", textKey: "devices.setup.tip.mount.text" },
  {
    icon: Sparkles,
    titleKey: "devices.setup.tip.energy.title",
    pointKeys: [
      "devices.setup.tip.energy.point1",
      "devices.setup.tip.energy.point2",
      "devices.setup.tip.energy.point3",
    ],
  },
  { icon: Activity, titleKey: "devices.setup.tip.live.title", textKey: "devices.setup.tip.live.text" },
];

// If the sensor does not come online for the first time within this period
// after creation, setup counts as failed.
const FAIL_MS = 20 * 60 * 1000;

// created_at arrives from the backend as "YYYY-MM-DD HH:MM:SS.ffffff" (naive UTC,
// str() of a TIMESTAMP column – no time zone suffix). Parse defensively and treat
// it as UTC when no zone is given (otherwise it is read as local time → offset of
// up to several hours and an immediate false "failed").
function parseTs(s) {
  if (!s) return null;
  let iso = s.includes("T") ? s : s.replace(" ", "T");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += "Z";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export default function DeviceSetupAnimation({ className = "", variant = "full", createdAt, onRestartSetup }) {
  const t = useT();
  const [idx, setIdx] = useState(0);
  // Already failed on mount? (e.g. page opened late) → lazy init so the setup
  // view does not flash briefly.
  const [failed, setFailed] = useState(() => {
    const created = parseTs(createdAt);
    return created != null && Date.now() - created >= FAIL_MS;
  });
  const compact = variant === "compact";

  // Own timer → guaranteed re-render on the transition to the failed state,
  // even without an SSE event. Without a valid created_at it stays in setup.
  useEffect(() => {
    if (failed) return;
    const created = parseTs(createdAt);
    if (created == null) return;
    const remaining = FAIL_MS - (Date.now() - created);
    const timer = setTimeout(() => setFailed(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [createdAt, failed]);

  const go = useCallback((delta, e) => {
    e?.preventDefault();
    e?.stopPropagation();
    setIdx((i) => (i + delta + TIPS.length) % TIPS.length);
  }, []);

  const tip = TIPS[idx];
  const Icon = tip.icon;

  if (failed) {
    return (
      <div className={`flex flex-col items-center text-center ${className}`}>
        <AlertTriangle className="size-7 text-amber-500" strokeWidth={1.75} />
        <p className="mt-3 text-sm font-medium text-foreground">{t("devices.setup.failed.title")}</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          {t("devices.setup.failed.text")}
        </p>
        <ul className="mt-3 max-w-xs space-y-1.5 text-left text-xs text-muted-foreground">
          <li className="flex gap-2">
            <span className="text-amber-500">•</span>
            <span>{t("devices.setup.failed.hintWifi")}</span>
          </li>
          <li className="flex gap-2">
            <span className="text-amber-500">•</span>
            <span>{t("devices.setup.failed.hintRestart")}</span>
          </li>
        </ul>
        {onRestartSetup && (
          <button
            type="button"
            onClick={onRestartSetup}
            className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-500/25 dark:text-amber-100"
          >
            {t("devices.setup.restart")}
          </button>
        )}
      </div>
    );
  }

  if (compact) {
    return (
      <div className={`flex flex-col items-center text-center ${className}`}>
        <Loader2 className="size-6 animate-spin text-primary" strokeWidth={1.75} />
        <p className="mt-2 text-sm font-medium text-foreground/90">{t("devices.setup.inProgress")}</p>
        <div className="mt-2 min-h-[88px] text-left">
          <div className="flex items-center gap-1.5">
            <Icon className="size-3.5 shrink-0 text-primary" strokeWidth={1.75} />
            <span className="text-xs font-medium text-foreground/80">{t(tip.titleKey)}</span>
          </div>
          {tip.pointKeys ? (
            <ul className="mt-1 space-y-0.5 text-xs leading-snug text-muted-foreground">
              {tip.pointKeys.map((p) => (
                <li key={p} className="flex gap-1">
                  <span className="text-primary">•</span>
                  <span>{t(p)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs leading-snug text-muted-foreground">{t(tip.textKey)}</p>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => go(-1, e)}
            aria-label={t("devices.setup.prevTip")}
            className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <span className="text-xs tabular-nums text-muted-foreground/60">
            {idx + 1} / {TIPS.length}
          </span>
          <button
            type="button"
            onClick={(e) => go(1, e)}
            aria-label={t("devices.setup.nextTip")}
            className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col items-center text-center ${className}`}>
      <Loader2 className="size-7 animate-spin text-primary" strokeWidth={1.75} />
      <p className="mt-3 text-sm font-medium text-foreground/90">{t("devices.setup.inProgress")}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("devices.setup.duration")}</p>

      <div className="mt-5 w-full max-w-md">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => go(-1, e)}
            aria-label={t("devices.setup.prevTip")}
            className="grid size-8 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </button>

          <div className="min-h-[136px] flex-1 rounded-xl border border-border/70 bg-background/50 px-4 py-4 text-left">
            <div className="flex items-center gap-2">
              <Icon className="size-4 text-primary" strokeWidth={1.75} />
              <span className="text-sm font-medium text-foreground">{t(tip.titleKey)}</span>
            </div>
            {tip.pointKeys ? (
              <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                {tip.pointKeys.map((p) => (
                  <li key={p} className="flex gap-2">
                    <span className="text-primary">•</span>
                    <span className="leading-relaxed">{t(p)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(tip.textKey)}</p>
            )}
          </div>

          <button
            type="button"
            onClick={(e) => go(1, e)}
            aria-label={t("devices.setup.nextTip")}
            className="grid size-8 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="mt-4 flex justify-center gap-1.5">
          {TIPS.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t("devices.setup.tipN", { n: i + 1 })}
              onClick={(e) => {
                e.preventDefault();
                setIdx(i);
              }}
              className={`h-1.5 rounded-full transition-all ${i === idx ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50"}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
