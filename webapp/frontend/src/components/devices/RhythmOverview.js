"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { detectRhythmGroups, rhythmStats } from "@/lib/hitStats";
import { getIntlLocale, useLocale, useT } from "@/lib/i18n";

const WINDOW_MS = 60000;
const DAY_BUCKET_MS = 10 * 60 * 1000;
const TIME_FORMAT = { hour: "2-digit", minute: "2-digit", second: "2-digit" };
const TOOLTIP_TIME_FORMAT = {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
};

function formatEnergy(value) {
  return value == null
    ? "–"
    : value.toLocaleString(getIntlLocale(), { maximumFractionDigits: 2 });
}

function niceEnergyMaximum(value) {
  if (!(value > 0)) return 1;
  const target = value * 1.12;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const fraction = target / magnitude;
  const step = [1, 1.25, 1.5, 2, 2.5, 5, 10].find((candidate) => candidate >= fraction) || 10;
  return step * magnitude;
}

function formatInterval(intervalMs) {
  if (intervalMs == null) return "–";
  return `${(intervalMs / 1000).toLocaleString(getIntlLocale(), { maximumFractionDigits: 2 })} s`;
}

function dayBounds(dateKey) {
  const start = new Date(`${dateKey}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function aggregateEnergyDay(points, dayStart) {
  const buckets = new Map();
  points.forEach((point) => {
    const bucketStart = dayStart + Math.floor((point.ts - dayStart) / DAY_BUCKET_MS) * DAY_BUCKET_MS;
    const bucket = buckets.get(bucketStart) || {
      bucketStart,
      bucketEnd: bucketStart + DAY_BUCKET_MS,
      count: 0,
      sum: 0,
      min: point.value,
      max: point.value,
    };
    bucket.count += 1;
    bucket.sum += point.value;
    bucket.min = Math.min(bucket.min, point.value);
    bucket.max = Math.max(bucket.max, point.value);
    buckets.set(bucketStart, bucket);
  });
  return [...buckets.values()].sort((a, b) => a.bucketStart - b.bucketStart).map((bucket) => ({
    ...bucket,
    ts: bucket.bucketStart + DAY_BUCKET_MS / 2,
    value: bucket.sum / bucket.count,
    aggregate: true,
  }));
}

function EnergyTooltip({ active, payload }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const start = point.aggregate ? new Date(point.bucketStart).toLocaleTimeString(intlLocale, { hour: "2-digit", minute: "2-digit" }) : null;
  const end = point.aggregate ? new Date(point.bucketEnd).toLocaleTimeString(intlLocale, { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className="min-w-44 rounded-lg border border-border/80 bg-popover/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur-sm">
      <div className="text-label">{point.aggregate ? t("deviceDetail.rhythm.energyAverage") : t("deviceDetail.rhythm.energy")}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-foreground">{formatEnergy(point.value)}</div>
      <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-muted-foreground">
        <dt>{t("deviceDetail.rhythm.tooltip.time")}</dt>
        <dd className="text-right tabular-nums text-foreground">{point.aggregate ? `${start}–${end}` : new Date(point.ts).toLocaleTimeString(intlLocale, TOOLTIP_TIME_FORMAT)}</dd>
        {point.aggregate ? (
          <>
            <dt>{t("deviceDetail.rhythm.tooltip.strokes")}</dt>
            <dd className="text-right tabular-nums text-foreground">{point.count}</dd>
            <dt>{t("deviceDetail.rhythm.tooltip.range")}</dt>
            <dd className="text-right tabular-nums text-foreground">{formatEnergy(point.min)}–{formatEnergy(point.max)}</dd>
          </>
        ) : (
          <>
            <dt>{t("deviceDetail.rhythm.tooltip.gapBefore")}</dt>
            <dd className="text-right tabular-nums text-foreground">{formatInterval(point.intervalMs)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function typicalGroup(groups) {
  const counts = new Map();
  groups.forEach((group) => counts.set(group.size, (counts.get(group.size) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

export default function RhythmOverview({
  deviceId,
  selectedDate,
  liveTimestamps = [],
  liveEnergyPoints = [],
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const dataKey = `${deviceId}:${selectedDate}`;
  const [storedData, setStoredData] = useState({ key: null, timestamps: [], energy: [] });
  const [navigation, setNavigation] = useState({ key: null, end: null });
  const [activeEnergyPoint, setActiveEnergyPoint] = useState(null);
  const [energyMode, setEnergyMode] = useState("rhythm");

  useEffect(() => {
    let active = true;
    api.get(`/devices/${deviceId}/data/rhythm`, { params: { date: selectedDate } })
      .then(({ data }) => {
        if (active) setStoredData({
          key: dataKey,
          timestamps: data.ts,
          energy: Array.isArray(data.energy) ? data.energy : [],
        });
      });
    return () => { active = false; };
  }, [dataKey, deviceId, selectedDate]);

  const timestamps = useMemo(() => {
    const stored = storedData.key === dataKey ? storedData.timestamps : [];
    return [...new Set([...stored, ...liveTimestamps])].sort((a, b) => a - b);
  }, [dataKey, liveTimestamps, storedData]);
  const latest = timestamps.at(-1);
  const selectedWindowEnd = navigation.key === dataKey ? navigation.end : null;
  const windowEnd = selectedWindowEnd == null ? latest : Math.min(selectedWindowEnd, latest);
  const windowStart = windowEnd ? windowEnd - WINDOW_MS : 0;
  const visible = useMemo(
    () => timestamps.filter((value) => value > windowStart && value <= windowEnd),
    [timestamps, windowEnd, windowStart],
  );
  const stats = useMemo(() => rhythmStats(visible), [visible]);
  const groupingTimestamps = useMemo(
    () => windowEnd == null
      ? []
      : timestamps.filter((value) => (
        value > windowStart - WINDOW_MS && value <= windowEnd + WINDOW_MS
      )),
    [timestamps, windowEnd, windowStart],
  );
  const grouping = useMemo(
    () => detectRhythmGroups(groupingTimestamps, { rangeStart: windowStart, rangeEnd: windowEnd }),
    [groupingTimestamps, windowEnd, windowStart],
  );
  const groupSize = grouping.confident ? typicalGroup(grouping.groups) : null;
  const energyPoints = useMemo(() => {
    const stored = storedData.key === dataKey ? storedData.energy : [];
    const byTimestamp = new Map();
    [...stored, ...liveEnergyPoints].forEach((point) => {
      const ts = Number(point.ts);
      const value = Number(point.value);
      if (Number.isFinite(ts) && Number.isFinite(value) && value >= 0) {
        byTimestamp.set(ts, { ts, value });
      }
    });
    return [...byTimestamp.values()].sort((a, b) => a.ts - b.ts);
  }, [dataKey, liveEnergyPoints, storedData]);
  const visibleEnergy = energyPoints.filter((point) => point.ts > windowStart && point.ts <= windowEnd);
  const rhythmEnergyData = visibleEnergy.map((point, index) => ({
    ...point,
    intervalMs: index > 0 ? point.ts - visibleEnergy[index - 1].ts : null,
  }));
  const selectedDay = dayBounds(selectedDate);
  const dayEnergyData = aggregateEnergyDay(energyPoints, selectedDay.start);
  const energyChartData = energyMode === "day" ? dayEnergyData : rhythmEnergyData;
  const energyValues = energyChartData.map((point) => point.value);
  const energyMin = energyValues.length ? Math.min(...energyValues) : null;
  const energyMax = energyValues.length ? Math.max(...energyValues) : null;
  const energyDomainMax = niceEnergyMaximum(energyMax);
  const chartStart = energyMode === "day" ? selectedDay.start : windowStart;
  const chartEnd = energyMode === "day" ? selectedDay.end : windowEnd;
  const energyTicks = chartEnd
    ? Array.from({ length: energyMode === "day" ? 7 : 5 }, (_, index) => (
      chartStart + ((chartEnd - chartStart) * index) / (energyMode === "day" ? 6 : 4)
    ))
    : [];
  const latestVisibleEnergy = rhythmEnergyData.at(-1)?.value ?? null;
  const dayEnergyAverage = energyPoints.length
    ? energyPoints.reduce((sum, point) => sum + point.value, 0) / energyPoints.length
    : null;
  const headlineEnergy = energyMode === "day" ? dayEnergyAverage : latestVisibleEnergy;
  const canGoBack = Boolean(windowEnd && timestamps.some((value) => value <= windowStart));
  const canGoForward = Boolean(selectedWindowEnd != null && latest && windowEnd < latest);
  const isLatestWindow = !canGoForward;
  const energyViewKey = `${dataKey}:${energyMode}`;
  const hoveredEnergyPoint = activeEnergyPoint?.key === energyViewKey
    ? activeEnergyPoint
    : null;

  function handleEnergyHover(state) {
    const index = Number(state?.activeTooltipIndex);
    const point = Number.isInteger(index) ? energyChartData[index] : null;
    setActiveEnergyPoint(state?.isTooltipActive && point
      ? { key: energyViewKey, ts: point.ts, value: point.value }
      : null);
  }

  function selectEnergyMode(mode) {
    setActiveEnergyPoint(null);
    setEnergyMode(mode);
  }

  function showPreviousWindow() {
    if (!windowEnd) return;
    setActiveEnergyPoint(null);
    setNavigation({ key: dataKey, end: windowEnd - WINDOW_MS });
  }

  function showNextWindow() {
    if (!windowEnd || !latest) return;
    setActiveEnergyPoint(null);
    const nextEnd = windowEnd + WINDOW_MS;
    setNavigation({ key: dataKey, end: nextEnd >= latest ? null : nextEnd });
  }

  function showLatestWindow() {
    setActiveEnergyPoint(null);
    setNavigation({ key: dataKey, end: null });
  }

  return (
    <>
      <section className="mt-6 rounded-xl border border-border/60 bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><h3 className="text-sm font-medium">{t("deviceDetail.rhythm.title")}</h3><p className="mt-1 text-xs text-muted-foreground">{t("deviceDetail.rhythm.subtitle")}</p></div>
          <div className="flex gap-6 text-right">
            <div><div className="text-label">{t("deviceDetail.rhythm.cycle")}</div><div className="mt-1 font-medium tabular-nums">{stats.medianIntervalMs ? `${(stats.medianIntervalMs / 1000).toFixed(1)} s` : "–"}</div></div>
            {groupSize && <div><div className="text-label">{t("deviceDetail.rhythm.typicalGroup")}</div><div className="mt-1 font-medium tabular-nums">{t("deviceDetail.rhythm.groupStrokes", { count: groupSize })}</div></div>}
          </div>
        </div>
        <div className="relative mt-5 h-12 overflow-hidden rounded-lg bg-muted/35">
          <div className="absolute inset-x-3 top-1/2 h-px bg-border" />
          {visible.map((timestamp) => <span key={timestamp} className="absolute top-2 h-8 w-0.5 rounded-full bg-primary" style={{ left: `${8 + ((timestamp - windowStart) / WINDOW_MS) * 84}%` }} />)}
          {!visible.length && <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">{t("deviceDetail.rhythm.empty")}</span>}
        </div>
        {latest && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {t("deviceDetail.rhythm.window", { start: new Date(windowStart).toLocaleTimeString(intlLocale, TIME_FORMAT), end: new Date(windowEnd).toLocaleTimeString(intlLocale, TIME_FORMAT) })}
            </p>
            <div className="flex items-center gap-1" role="group" aria-label={t("deviceDetail.rhythm.windowLabel")}>
              <Button variant="outline" size="icon-xs" onClick={showPreviousWindow} disabled={!canGoBack} aria-label={t("deviceDetail.rhythm.back")} title={t("deviceDetail.rhythm.back")}>
                <ChevronLeft />
              </Button>
              <Button variant="outline" size="icon-xs" onClick={showNextWindow} disabled={!canGoForward} aria-label={t("deviceDetail.rhythm.forward")} title={t("deviceDetail.rhythm.forward")}>
                <ChevronRight />
              </Button>
              <Button variant={isLatestWindow ? "secondary" : "outline"} size="xs" onClick={showLatestWindow} disabled={isLatestWindow}>
                {t("deviceDetail.rhythm.latest")}
              </Button>
            </div>
          </div>
        )}
      </section>
      <section className="mt-4 rounded-xl border border-border/60 bg-card p-4 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">{t("deviceDetail.rhythm.energy")}</h3>
            <p className="mt-1 text-xs text-muted-foreground">{t("deviceDetail.rhythm.energySubtitle")}</p>
          </div>
          <div className="flex flex-wrap items-start justify-end gap-4">
            <div className="inline-flex rounded-lg border border-border/70 bg-muted/35 p-0.5" role="group" aria-label={t("deviceDetail.rhythm.energyRangeLabel")}>
              <button
                type="button"
                onClick={() => selectEnergyMode("rhythm")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${energyMode === "rhythm" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={energyMode === "rhythm"}
              >
                {t("deviceDetail.rhythm.modeRhythm")}
              </button>
              <button
                type="button"
                onClick={() => selectEnergyMode("day")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${energyMode === "day" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={energyMode === "day"}
              >
                {t("deviceDetail.rhythm.modeDay")}
              </button>
            </div>
            <div className="min-w-20 text-right">
              <div className="text-label">{energyMode === "day" ? t("deviceDetail.rhythm.dayAverage") : t("deviceDetail.rhythm.lastValue")}</div>
              <div className="mt-1 font-medium tabular-nums">{formatEnergy(headlineEnergy)}</div>
            </div>
          </div>
        </div>
        <div className="relative mt-5 h-48 rounded-lg border border-border/40 bg-muted/20 px-1 pt-3 sm:h-52">
          {energyChartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={energyChartData}
                margin={{ top: 4, right: 18, bottom: 2, left: 0 }}
                onMouseMove={handleEnergyHover}
                onMouseLeave={() => setActiveEnergyPoint(null)}
              >
                <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="var(--border)" />
                <XAxis
                  type="number"
                  dataKey="ts"
                  domain={[chartStart, chartEnd]}
                  ticks={energyTicks}
                  tickFormatter={(value) => energyMode === "day" && value === selectedDay.end
                    ? "24:00"
                    : new Date(value).toLocaleTimeString(intlLocale, energyMode === "day" ? { hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={{ stroke: "var(--border)" }}
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis
                  domain={[0, energyDomainMax]}
                  ticks={[0, energyDomainMax / 2, energyDomainMax]}
                  tickFormatter={formatEnergy}
                  tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<EnergyTooltip />} cursor={false} isAnimationActive={false} />
                <Line
                  type="linear"
                  dataKey="value"
                  name={t("deviceDetail.rhythm.energySeries")}
                  stroke="var(--primary)"
                  strokeWidth={2.5}
                  dot={{ r: energyMode === "day" ? 2.5 : 3, fill: "var(--card)", stroke: "var(--primary)", strokeWidth: 2 }}
                  activeDot={{ r: 5, fill: "var(--primary)", stroke: "var(--card)", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
                {hoveredEnergyPoint && (
                  <>
                    <ReferenceLine x={hoveredEnergyPoint.ts} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.65} />
                    <ReferenceLine y={hoveredEnergyPoint.value} stroke="var(--muted-foreground)" strokeDasharray="4 4" strokeOpacity={0.65} />
                  </>
                )}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">{energyMode === "day" ? t("deviceDetail.rhythm.noEnergyDay") : t("deviceDetail.rhythm.noEnergyWindow")}</span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <p>{energyMode === "day" ? t("deviceDetail.rhythm.dayFooter", { count: energyPoints.length.toLocaleString(intlLocale) }) : t("deviceDetail.rhythm.rhythmFooter")}</p>
          {energyMin != null && <p className="tabular-nums">{t("deviceDetail.rhythm.rangeFooter", { min: formatEnergy(energyMin), max: formatEnergy(energyMax) })}</p>}
        </div>
      </section>
    </>
  );
}
