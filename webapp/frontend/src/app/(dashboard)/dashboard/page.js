"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, MonitorSmartphone, MonitorUp } from "lucide-react";
import api from "@/lib/api";
import { fadeRise, staggerContainer } from "@/lib/motion";
import DashboardCard from "@/components/devices/DashboardCard";
import ActivityTimeline from "@/components/charts/ActivityTimeline";
import { DashboardCardSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import { useLocale, useT } from "@/lib/i18n";

const SORT_STORAGE_KEY = "foriq.dashboardSort";
const SORT_OPTIONS = [
  { value: "added_desc", labelKey: "dashboard.sort.newest" },
  { value: "added_asc", labelKey: "dashboard.sort.oldest" },
  { value: "name", labelKey: "dashboard.sort.name" },
];

function toDateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function DashboardPage() {
  const router = useRouter();
  const fleet = useFleetLive();
  const t = useT();
  const { intlLocale } = useLocale();
  const [selectedDate, setSelectedDate] = useState(null);
  const [pastDevices, setPastDevices] = useState([]);
  const [pastLoading, setPastLoading] = useState(false);
  const [sortBy, setSortBy] = useState("name");

  useEffect(() => {
    const saved = localStorage.getItem(SORT_STORAGE_KEY);
    if (SORT_OPTIONS.some((option) => option.value === saved)) {
      const timer = setTimeout(() => setSortBy(saved), 0);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    let active = true;
    api.get("/dashboard/overview", { params: { date: selectedDate } })
      .then(({ data }) => { if (active) setPastDevices(data); })
      .finally(() => { if (active) setPastLoading(false); });
    return () => { active = false; };
  }, [selectedDate]);

  const devices = selectedDate ? pastDevices : fleet.devices;
  const loading = selectedDate ? pastLoading : fleet.loading;
  const sortedDevices = useMemo(() => {
    const result = [...devices];
    if (sortBy === "name") return result.sort((a, b) => (a.name || "").localeCompare(b.name || "", intlLocale));
    const direction = sortBy === "added_asc" ? 1 : -1;
    return result.sort((a, b) => direction * (new Date(a.created_at || 0) - new Date(b.created_at || 0)));
  }, [devices, sortBy, intlLocale]);

  function shiftDay(delta) {
    const current = selectedDate ? new Date(`${selectedDate}T12:00:00`) : new Date();
    current.setDate(current.getDate() + delta);
    const key = toDateKey(current);
    const next = key >= toDateKey(new Date()) ? null : key;
    if (next) setPastLoading(true);
    setSelectedDate(next);
  }

  const shownDate = selectedDate ? new Date(`${selectedDate}T12:00:00`) : new Date();

  async function openMonitor() {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch { /* The route also works without browser fullscreen. */ }
    }
    router.push("/monitor");
  }

  return (
    <div className="mx-auto w-full max-w-6xl pt-2 md:pt-6">
      <header className="mb-6 flex flex-wrap items-center gap-4 md:mb-8">
        <h1 className="flex-1 text-[22px] font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <div className="flex items-center text-sm text-muted-foreground">
          <button onClick={() => shiftDay(-1)} className="grid size-7 place-items-center rounded-md hover:bg-muted/60" aria-label={t("dashboard.previousDay")}><ChevronLeft className="size-4" /></button>
          <span className="w-48 text-center">{shownDate.toLocaleDateString(intlLocale, { weekday: "long", day: "numeric", month: "long" })}</span>
          <button onClick={() => shiftDay(1)} disabled={!selectedDate} className="grid size-7 place-items-center rounded-md hover:bg-muted/60 disabled:opacity-30" aria-label={t("dashboard.nextDay")}><ChevronRight className="size-4" /></button>
          <button onClick={() => setSelectedDate(null)} className={`ml-1 rounded-md border px-2 py-0.5 text-xs ${selectedDate ? "" : "invisible"}`}>{t("dashboard.today")}</button>
        </div>
        <div className="flex flex-1 items-center justify-end gap-2">
          {!selectedDate && devices.length > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={openMonitor}>
              <MonitorUp className="size-4" />
              {t("dashboard.monitorView")}
            </Button>
          )}
          {devices.length > 1 && (
            <select value={sortBy} onChange={(event) => { setSortBy(event.target.value); localStorage.setItem(SORT_STORAGE_KEY, event.target.value); }} className="h-9 rounded-md border bg-transparent px-3 text-sm">
              {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
            </select>
          )}
        </div>
      </header>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">{Array.from({ length: 4 }, (_, index) => <DashboardCardSkeleton key={index} />)}</div>
      ) : devices.length === 0 ? (
        <EmptyState icon={MonitorSmartphone} title={t("dashboard.empty.title")} subtitle={t("dashboard.empty.subtitle")} />
      ) : (
        <motion.div variants={staggerContainer} initial="hidden" animate="visible">
          {devices.length > 1 && <motion.div variants={fadeRise} className="mb-4"><ActivityTimeline devices={sortedDevices} /></motion.div>}
          <motion.div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" variants={staggerContainer}>
            {sortedDevices.map((device) => <motion.div key={device.id} variants={fadeRise}><DashboardCard device={device} isToday={!selectedDate} /></motion.div>)}
          </motion.div>
        </motion.div>
      )}
    </div>
  );
}
