"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, MoveHorizontal, X } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { useLocale, useT } from "@/lib/i18n";
import {
  formatDayMonth,
  formatDayOfMonth,
  formatMonthYear,
  formatWeekdayShort,
} from "@/lib/dates";

const MODE_LABEL_KEYS = {
  day: "charts.mode.day",
  week: "charts.mode.week",
  month: "charts.mode.month",
};

// ─── Day helpers ───────────────────────────────────────────

function buildDayBuckets(data) {
  const countByBucket = {};
  for (const d of data) {
    const t = new Date(d.bucket);
    const key = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    countByBucket[key] = (countByBucket[key] || 0) + d.count;
  }

  const buckets = [];
  for (let i = 0; i < 144; i++) {
    const h = Math.floor(i / 6);
    const m = (i % 6) * 10;
    const label = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    buckets.push({ label, count: countByBucket[label] || 0 });
  }
  return buckets;
}

// Mount-only animation: the first render with real data animates (400 ms),
// after that isAnimationActive stays off — live/SSE updates would flicker.
function useMountOnlyAnimation(hasData) {
  const [animate, setAnimate] = useState(true);
  useEffect(() => {
    if (!hasData || !animate) return;
    const timer = setTimeout(() => setAnimate(false), 450);
    return () => clearTimeout(timer);
  }, [hasData, animate]);
  return hasData && animate;
}

const BAR_ANIMATION = { animationDuration: 400, animationEasing: "ease-out" };

function LoadingPlaceholder() {
  return (
    <div className="flex h-full items-end gap-1 px-2 pb-1">
      {[40, 65, 50, 80, 35, 70, 55, 90, 45, 60, 75, 50].map((h, i) => (
        <Skeleton key={i} className="w-full" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

// ─── Day Chart ─────────────────────────────────────────────

function DayView({ data }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const buckets = useMemo(() => buildDayBuckets(data), [data]);
  const interval = buckets.length <= 12 ? 2 : Math.floor(buckets.length / 6) - 1;
  const [selection, setSelection] = useState(null);
  const selectionLayerRef = useRef(null);
  const dragStartRef = useRef(null);

  const animateBars = useMountOnlyAnimation(buckets.some((b) => b.count > 0));

  const selectionStats = useMemo(() => {
    if (!selection) return null;
    const start = Math.min(selection.start, selection.end);
    const end = Math.max(selection.start, selection.end);
    const count = buckets.slice(start, end + 1).reduce((sum, bucket) => sum + bucket.count, 0);
    const bucketCount = end - start + 1;
    const endMinutes = (end + 1) * 10;
    const endLabel = endMinutes === 1440
      ? "24:00"
      : `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

    return {
      start,
      end,
      count,
      rate: count / (bucketCount / 6),
      range: `${buckets[start].label}–${endLabel}`,
    };
  }, [buckets, selection]);

  function bucketIndexAt(clientX) {
    const rect = selectionLayerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const position = Math.max(0, Math.min(rect.width - 0.01, clientX - rect.left));
    return Math.floor((position / rect.width) * buckets.length);
  }

  function handlePointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const index = bucketIndexAt(event.clientX);
    dragStartRef.current = index;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection({ start: index, end: index });
  }

  function handlePointerMove(event) {
    if (dragStartRef.current == null) return;
    setSelection({ start: dragStartRef.current, end: bucketIndexAt(event.clientX) });
  }

  function finishSelection(event) {
    dragStartRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex min-h-8 items-center justify-between gap-3 text-xs">
        {selectionStats ? (
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="shrink-0 font-medium tabular-nums text-foreground">{selectionStats.range}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground"><strong className="font-semibold text-foreground">{selectionStats.count}</strong> {t("charts.pieces")}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground"><strong className="font-semibold text-foreground">{selectionStats.rate.toLocaleString(intlLocale, { maximumFractionDigits: 1 })}</strong> {t("charts.piecesPerHour")}</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MoveHorizontal className="size-3.5" />
            <span>{t("charts.dragHint")}</span>
          </div>
        )}
        {selectionStats && (
          <button
            type="button"
            onClick={() => setSelection(null)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("charts.clearSelection")}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={interval} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={30} />
            <Tooltip />
            <Bar
              dataKey="count"
              name={t("charts.measurements")}
              radius={[2, 2, 0, 0]}
              isAnimationActive={animateBars}
              {...BAR_ANIMATION}
              fill="var(--primary)"
            />
          </BarChart>
        </ResponsiveContainer>
        <div
          ref={selectionLayerRef}
          className="absolute inset-y-0 right-0 left-[30px] z-10 cursor-col-resize select-none touch-pan-y"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishSelection}
          onPointerCancel={finishSelection}
          aria-label={t("charts.selectRange")}
        >
          {selectionStats && (
            <div
              className="pointer-events-none absolute inset-y-0 border-x border-primary/70 bg-primary/15"
              style={{
                left: `${(selectionStats.start / buckets.length) * 100}%`,
                width: `${((selectionStats.end - selectionStats.start + 1) / buckets.length) * 100}%`,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Week Chart ────────────────────────────────────────────

function WeekView({ data }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const { days = [] } = data || {};
  const chartData = useMemo(() => days.map((day) => ({
    label: `${formatWeekdayShort(day.date, intlLocale)} ${formatDayMonth(day.date, intlLocale)}`,
    total: day.total || 0,
  })), [days, intlLocale]);

  const animateBars = useMountOnlyAnimation(chartData.length > 0);

  if (!data) return <LoadingPlaceholder />;

  return (
    <div className="relative h-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={30} />
          <Tooltip />
          <Bar dataKey="total" name={t("charts.measurements")} fill="var(--primary)" radius={[2, 2, 0, 0]} isAnimationActive={animateBars} {...BAR_ANIMATION} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Month Chart ───────────────────────────────────────────

function MonthView({ data }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const days = useMemo(() => (data?.days || []).map((day) => ({
    ...day,
    label: formatDayOfMonth(day.date, intlLocale),
    weekday: formatWeekdayShort(day.date, intlLocale),
  })), [data, intlLocale]);

  const animateBars = useMountOnlyAnimation(days.length > 0);

  if (!data) return <LoadingPlaceholder />;

  return (
    <div className="relative h-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={days}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={30} />
          <Tooltip
              labelFormatter={(label, payload) => {
                const entry = payload?.[0]?.payload;
                return entry ? `${entry.weekday} ${entry.label}` : label;
              }}
          />
          <Bar
            dataKey="count"
            name={t("charts.measurements")}
            fill="var(--primary)"
            radius={[2, 2, 0, 0]}
            isAnimationActive={animateBars}
            {...BAR_ANIMATION}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────

export default function DayChart({
  mode = "day",
  onModeChange,
  data = [],
  weekData = null,
  monthData = null,
  selectionKey = "day",
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  let subtitle = t("charts.subtitle.tenMinute");
  let title = t("charts.title.day");

  if (mode === "week") {
    title = t("charts.title.week");
    const ws = weekData?.week_start;
    const we = weekData?.week_end;
    if (ws && we) {
      const s = new Date(ws);
      const e = new Date(we);
      const thu = new Date(s);
      thu.setDate(s.getDate() + 3 - ((s.getDay() + 6) % 7));
      const yearStart = new Date(thu.getFullYear(), 0, 1);
      const kw = Math.ceil(((thu - yearStart) / 86400000 + 1) / 7);
      const dayMonth = { day: "2-digit", month: "2-digit" };
      subtitle = t("charts.subtitle.week", {
        week: kw,
        start: s.toLocaleDateString(intlLocale, dayMonth),
        end: e.toLocaleDateString(intlLocale, dayMonth),
      });
    } else {
      subtitle = t("charts.subtitle.daily");
    }
  } else if (mode === "month") {
    title = t("charts.title.month");
    if (monthData?.days?.length) {
      subtitle = formatMonthYear(monthData.days[0].date, intlLocale);
    } else {
      subtitle = t("charts.subtitle.daily");
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">
            {subtitle}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                {t(MODE_LABEL_KEYS[mode])}
                <ChevronDown className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={mode} onValueChange={onModeChange}>
                <DropdownMenuRadioItem value="day">{t("charts.mode.day")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="week">{t("charts.mode.week")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="month">{t("charts.mode.month")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-4 h-64">
        {mode === "day" && (
          <DayView key={selectionKey} data={data} />
        )}
        {mode === "week" && <WeekView data={weekData} />}
        {mode === "month" && <MonthView data={monthData} />}
      </div>
    </div>
  );
}
