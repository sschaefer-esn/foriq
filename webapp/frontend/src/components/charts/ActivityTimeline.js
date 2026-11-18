"use client";

import { useMemo } from "react";
import Link from "next/link";
import { deviceStatus } from "@/lib/deviceStatus";
import useDeviceHref from "@/hooks/useDeviceHref";
import { useT } from "@/lib/i18n";

// Status dot colours — deliberately identical to DashboardCard so panel and
// cards speak the same language.
const STATUS_DOT = {
  online: "bg-emerald-500",
  sleeping: "bg-amber-400",
  provisioning: "bg-amber-500",
  offline: "bg-muted-foreground/40",
};

// Aggregate hourly buckets ({bucket, count}) into fixed 24 slots (0–23).
// bucket is a local-time ISO string without offset → new Date(...).getHours()
// yields the company-local hour (same assumption as buildSparkline in DashboardCard).
function hourlyCounts(chart) {
  const slots = new Array(24).fill(0);
  for (const d of chart || []) {
    const t = new Date(d.bucket);
    const h = t.getHours();
    if (h >= 0 && h < 24) slots[h] += d.count || 0;
  }
  return slots;
}

// Absolute, shared scale: darker = more pcs/h — comparable everywhere.
// Mild gamma (sqrt) so low-output machines stay visible.
function cellBackground(count, globalMax) {
  if (!count) {
    return "color-mix(in oklab, var(--muted-foreground) 7%, transparent)";
  }
  const t = Math.sqrt(count / globalMax);
  const pct = Math.round((0.12 + 0.88 * t) * 100);
  return `color-mix(in oklab, var(--primary) ${pct}%, transparent)`;
}

export default function ActivityTimeline({ devices }) {
  const deviceHref = useDeviceHref();
  const t = useT();
  const model = useMemo(() => {
    const active = (devices || []).filter((d) => (d.count_today || 0) > 0);
    if (active.length === 0) return null;

    const rows = active.map((d) => ({ device: d, slots: hourlyCounts(d.chart) }));

    let minH = 24;
    let maxH = -1;
    let globalMax = 0;
    for (const { slots } of rows) {
      for (let h = 0; h < 24; h++) {
        const c = slots[h];
        if (c > 0) {
          if (h < minH) minH = h;
          if (h > maxH) maxH = h;
          if (c > globalMax) globalMax = c;
        }
      }
    }
    if (maxH < 0) return null;

    // Dynamic window: active hours plus 1 h margin each side, clamped to [0,24).
    const start = Math.max(0, minH - 1);
    const end = Math.min(24, maxH + 2);
    const hours = [];
    for (let h = start; h < end; h++) hours.push(h);

    return { rows, hours, globalMax };
  }, [devices]);

  if (!model) return null;

  const { rows, hours, globalMax } = model;
  // Label every 2 h when the window is wide, otherwise every hour.
  const labelEvery = hours.length > 10 ? 2 : 1;
  const gridCols = { gridTemplateColumns: `repeat(${hours.length}, minmax(0, 1fr))` };
  // A minimum width forces horizontal scrolling on narrow screens instead of
  // squeezing the cells unreadably (224px label column + cells).
  const minWidth = 224 + hours.length * 24;

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-card sm:p-5">
      <div className="mb-3">
        <h2 className="text-[15px] font-medium text-foreground">{t("charts.timeline.title")}</h2>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          {/* Shared time axis */}
          <div className="mb-1 flex items-center">
            <div className="w-56 shrink-0" />
            <div className="flex-1 grid" style={gridCols}>
              {hours.map((h) => (
                <div
                  key={h}
                  className="text-center text-[10px] tabular-nums text-muted-foreground/70"
                >
                  {h % labelEvery === 0 ? h : ""}
                </div>
              ))}
            </div>
          </div>

          {/* One row per machine */}
          {rows.map(({ device, slots }) => {
            const status = deviceStatus(device);
            return (
              <Link
                key={device.id}
                href={deviceHref(device.id)}
                className="group flex items-center rounded-lg py-1 transition-colors hover:bg-muted/40"
              >
                <div className="flex w-56 shrink-0 items-center gap-1.5 pr-3">
                  <span
                    className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                    {device.name || t("charts.timeline.sensorFallback")}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {device.count_today}
                  </span>
                </div>
                <div className="flex-1 grid gap-px" style={gridCols}>
                  {hours.map((h) => (
                    <div
                      key={h}
                      className="h-6 rounded-[2px]"
                      style={{ background: cellBackground(slots[h], globalMax) }}
                      title={t("charts.timeline.cellTitle", { name: device.name || t("charts.timeline.sensorFallback"), from: h, to: h + 1, count: slots[h] })}
                    />
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Legend: absolute scale */}
      <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t("charts.timeline.low")}</span>
        <div className="flex gap-px">
          {[0.12, 0.35, 0.58, 0.8, 1].map((level) => (
            <span
              key={level}
              className="size-3 rounded-[2px]"
              style={{
                background: `color-mix(in oklab, var(--primary) ${Math.round(level * 100)}%, transparent)`,
              }}
            />
          ))}
        </div>
        <span>{t("charts.timeline.high")}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>{t("charts.timeline.legend", { max: globalMax })}</span>
      </div>
    </div>
  );
}
