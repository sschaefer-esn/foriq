"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, Download } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableRowsSkeleton } from "@/components/ui/Skeleton";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/lib/i18n";
import { formatDateRange, formatDayMonth, formatMonthYear, formatWeekdayShort } from "@/lib/dates";

function dateStr(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function moveDate(value, period, direction) {
  const [year, month, day] = value.split("-").map(Number);
  const next = new Date(year, month - 1, day, 12);
  if (period === "week") next.setDate(next.getDate() + direction * 7);
  else {
    // Normalise to the first of the month first: 31 Jan + 1 month must not
    // overflow into March.
    next.setDate(1);
    next.setMonth(next.getMonth() + direction);
  }
  return dateStr(next);
}

function summaryLabel(summary, intlLocale) {
  if (!summary?.range_start || !summary?.range_end) return "–";
  return summary.period === "month"
    ? formatMonthYear(summary.range_start, intlLocale)
    : formatDateRange(summary.range_start, summary.range_end, intlLocale);
}

export default function DataPage() {
  const t = useT();
  const { intlLocale } = useLocale();
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("all");
  const [period, setPeriod] = useState("week");
  const [selectedDate, setSelectedDate] = useState(() => dateStr(new Date()));
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);

  useEffect(() => {
    api.get("/devices").then(({ data }) => {
      setDevices([...data].sort((a, b) => a.name.localeCompare(b.name, intlLocale)));
    }).catch(() => setError(t("data.error.sensorsLoadFailed")));
  }, [intlLocale, t]);

  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const { data } = await api.get(`/devices/${deviceId}/data/summary`, {
        params: { period, date: selectedDate },
      });
      if (sequence !== requestSequence.current) return;
      setSummary(data);
    } catch {
      if (sequence !== requestSequence.current) return;
      setSummary(null);
      setError(t("data.error.loadFailed"));
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [deviceId, period, selectedDate, t]);

  useEffect(() => { load(); }, [load]);

  const selectedDeviceLabel = deviceId === "all"
    ? t("data.allMachines")
    : devices.find((device) => device.id === deviceId)?.name || t("data.machine");
  const total = useMemo(
    () => (summary?.days || []).reduce((sum, day) => sum + day.total, 0),
    [summary]
  );

  return (
    <div className="mx-auto w-full max-w-4xl pb-24 pt-2 md:pt-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{t("data.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("data.subtitle")}</p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/export"><Download className="mr-2 size-4" />{t("data.openExport")}</Link>
        </Button>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="inline-flex h-9 min-w-48 items-center justify-between gap-2 rounded-md border bg-card px-3 text-sm font-medium">
              {selectedDeviceLabel}<ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={deviceId} onValueChange={setDeviceId}>
              <DropdownMenuRadioItem value="all">{t("data.allMachines")}</DropdownMenuRadioItem>
              {devices.map((device) => (
                <DropdownMenuRadioItem key={device.id} value={device.id}>{device.name}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="inline-flex h-9 rounded-md border bg-card p-0.5">
          {[{ id: "week", label: t("data.period.week") }, { id: "month", label: t("data.period.month") }].map((item) => (
            <button
              key={item.id}
              onClick={() => setPeriod(item.id)}
              className={cn("rounded-[5px] px-4 text-sm font-medium", period === item.id ? "bg-foreground/5" : "text-muted-foreground")}
            >{item.label}</button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex items-center justify-between rounded-xl border bg-card px-3 py-2">
        <Button variant="ghost" size="icon" onClick={() => setSelectedDate((date) => moveDate(date, period, -1))} aria-label={t("data.previous")}>
          <ChevronLeft className="size-4" />
        </Button>
        <div className="text-center">
          <p className="text-sm font-medium">{summaryLabel(summary, intlLocale)}</p>
          <button onClick={() => setSelectedDate(dateStr(new Date()))} className="text-xs text-muted-foreground hover:text-foreground">{t("data.today")}</button>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setSelectedDate((date) => moveDate(date, period, 1))} aria-label={t("data.next")}>
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
      {loading ? <TableRowsSkeleton rows={8} /> : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-baseline justify-between border-b px-4 py-3">
            <span className="text-sm text-muted-foreground">{t("data.total")}</span>
            <span className="text-2xl font-semibold tabular-nums">{total.toLocaleString(intlLocale)}</span>
          </div>
          <div className="divide-y">
            {(summary?.days || []).map((day) => (
              <div key={day.date} className="grid grid-cols-[3rem_1fr_auto] items-center px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">{formatWeekdayShort(day.date, intlLocale)}</span>
                <span>{formatDayMonth(day.date, intlLocale)}</span>
                <span className="font-medium tabular-nums">{day.total.toLocaleString(intlLocale)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
