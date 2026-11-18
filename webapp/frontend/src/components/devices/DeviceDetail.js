"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { ChevronLeft, ChevronRight } from "lucide-react";
import api from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import useEventStream from "@/hooks/useEventStream";
import useVisibilityRefresh from "@/hooks/useVisibilityRefresh";
import { usePendingSettings } from "@/hooks/usePendingSettings";
import useNow from "@/hooks/useNow";
import { deviceStatus } from "@/lib/deviceStatus";
import { liveRate, pushLiveHit } from "@/lib/stall";
import DayChart from "@/components/charts/DayChart";
import RhythmOverview from "@/components/devices/RhythmOverview";
import PendingSettingsBreadcrumb from "@/components/devices/PendingSettingsBreadcrumb";
import DeviceSettingsView from "@/components/devices/DeviceSettingsView";
import AnimatedCounter from "@/components/ui/AnimatedCounter";
import { ChartSkeleton, DeviceDetailSkeleton } from "@/components/ui/Skeleton";
import DeviceSetupAnimation from "@/components/devices/DeviceSetupAnimation";
import { useDeviceSeed } from "@/hooks/useDeviceSeed";
import ProductionCounterPanel from "@/components/devices/ProductionCounterPanel";
import MachineCounterDisplay from "@/components/devices/MachineCounterDisplay";
import { useLocale, useT } from "@/lib/i18n";

const STATUS_DOT = {
  online: "bg-emerald-500 animate-[pulse-online_2s_ease-in-out_infinite]",
  sleeping: "bg-amber-400",
  provisioning: "bg-amber-500",
  offline: "bg-muted-foreground/40",
};
const STATUS_LABEL = {
  online: "deviceDetail.summary.status.online",
  sleeping: "deviceDetail.summary.status.sleeping",
  provisioning: "deviceDetail.summary.status.provisioning",
  offline: "deviceDetail.summary.status.offline",
};

function todayStr() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatRelative(value, now, t) {
  if (!value) return t("deviceDetail.relative.never");
  const minutes = Math.max(0, Math.round((now - new Date(value).getTime()) / 60000));
  if (minutes < 1) return t("deviceDetail.relative.justNow");
  if (minutes < 60) return t("deviceDetail.relative.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("deviceDetail.relative.hoursAgo", { count: hours });
  const days = Math.round(hours / 24);
  return t("deviceDetail.relative.daysAgo", { count: days });
}

function incidentLabel(incident, now, t) {
  if (!incident?.condition_since_at) return null;
  const minutes = Math.max(0, Math.floor((now - new Date(incident.condition_since_at).getTime()) / 60000));
  const duration = minutes < 60
    ? t("deviceDetail.summary.durationMinutes", { minutes })
    : t("deviceDetail.summary.durationHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return incident.type === "device_offline"
    ? t("deviceDetail.incident.offlineSince", { duration })
    : t("deviceDetail.incident.stallSince", { duration });
}

export default function DeviceDetail({ id, closeButton = null }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const router = useRouter();
  const { data: session } = useAuth();
  const canEdit = ["owner", "admin"].includes(session?.user?.role);
  const seed = useDeviceSeed(id);
  const [device, setDevice] = useState(() => seed ? { ...seed, rate_loaded_at: Date.now(), live_hit_times: [] } : null);
  const [loading, setLoading] = useState(!seed);
  const [chartData, setChartData] = useState([]);
  const [weekData, setWeekData] = useState(null);
  const [monthData, setMonthData] = useState(null);
  const [chartMode, setChartMode] = useState("day");
  const [chartLoaded, setChartLoaded] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayStr);
  const [liveTimestamps, setLiveTimestamps] = useState([]);
  const [liveEnergyPoints, setLiveEnergyPoints] = useState([]);
  const [lastCommandEvent, setLastCommandEvent] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [restartOpen, setRestartOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [machineDisplayOpen, setMachineDisplayOpen] = useState(false);
  const now = useNow(30000);
  const {
    addPending,
    addPendingFields,
    resolvePending,
    markFailed,
    clearAll,
    dismissStatus,
    settingsStatus,
  } = usePendingSettings(id);

  const loadDevice = useCallback(async () => {
    try {
      const { data } = await api.get(`/devices/${id}`);
      // The fresh server state already includes the live strokes received so far.
      setDevice((current) => ({ ...current, ...data, rate_loaded_at: Date.now(), live_hit_times: [] }));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadChart = useCallback(async ({ showLoading = false } = {}) => {
    if (showLoading) setChartLoaded(false);
    const params = { date: selectedDate };
    try {
      const requests = [api.get(`/devices/${id}/data/day`, { params })];
      if (chartMode === "week") requests.push(api.get(`/devices/${id}/data/week`, { params }));
      if (chartMode === "month") requests.push(api.get(`/devices/${id}/data/month`, { params }));
      const results = await Promise.all(requests);
      setChartData(results[0].data);
      if (chartMode === "week") setWeekData(results[1].data);
      if (chartMode === "month") setMonthData(results[1].data);
    } finally {
      setChartLoaded(true);
    }
  }, [chartMode, id, selectedDate]);

  useEffect(() => { loadDevice(); }, [loadDevice]);
  useEffect(() => { loadChart({ showLoading: true }); }, [loadChart]);
  useEffect(() => {
    const heartbeat = () => api.post(`/devices/${id}/watching`).catch(() => {});
    heartbeat();
    const timer = setInterval(heartbeat, 30000);
    return () => clearInterval(timer);
  }, [id]);

  const isToday = selectedDate === todayStr();
  const handleEvent = useCallback((event) => {
    if (event.type === "notification") { loadDevice(); return; }
    if (String(event.data?.device_id) !== String(id)) return;

    if (event.type === "production_updated") {
      setDevice((current) => current ? { ...current, production: event.data.production ?? null } : current);
      return;
    }

    if (event.type === "config_pushed") {
      addPendingFields(event.data.fields || {});
      return;
    }
    if (event.type === "settings_sync") {
      const config = event.data.downstream_config || {};
      setDevice((current) => current ? {
        ...current,
        ...config,
        last_seen_at: event.data.last_seen_at || current.last_seen_at,
        firmware_version: event.data.firmware_version ?? current.firmware_version,
      } : current);
      resolvePending(config);
      return;
    }
    if (event.type === "status") {
      setDevice((current) => current ? { ...current, last_seen_at: event.data.last_seen_at || current.last_seen_at, sleep_mode: event.data.sleep_mode ?? current.sleep_mode } : current);
      return;
    }
    if (event.type === "command_status") { setLastCommandEvent(event.data); return; }
    if (event.type !== "hit") return;

    const timestamp = new Date(event.data.recorded_at).getTime();
    setLiveTimestamps((current) => [...current, timestamp].slice(-500));
    if (event.data.energy != null && Number.isFinite(Number(event.data.energy))) {
      setLiveEnergyPoints((current) => [
        ...current,
        { ts: timestamp, value: Number(event.data.energy) },
      ].slice(-500));
    }
    setDevice((current) => current ? {
      ...current,
      count_today: (current.count_today || 0) + 1,
      last_seen_at: event.data.last_seen_at || current.last_seen_at,
      last_hit_at: event.data.recorded_at,
      live_hit_times: pushLiveHit(current.live_hit_times),
      active_incident: null,
      sleep_mode: false,
      production: current.production && timestamp >= new Date(current.production.started_at).getTime()
        ? {
            ...current.production,
            current_count: (current.production.current_count || 0) + 1,
            remaining_count: Math.max(0, current.production.target_count - (current.production.current_count || 0) - 1),
            material_remaining: current.production.material_count == null
              ? null
              : Math.max(0, current.production.material_count - (current.production.current_count || 0) - 1),
          }
        : current.production,
    } : current);
    if (isToday && chartMode === "day") {
      const bucketDate = new Date(event.data.recorded_at);
      bucketDate.setMinutes(Math.floor(bucketDate.getMinutes() / 10) * 10, 0, 0);
      const pad = (value) => String(value).padStart(2, "0");
      const bucket = `${bucketDate.getFullYear()}-${pad(bucketDate.getMonth() + 1)}-${pad(bucketDate.getDate())}T${pad(bucketDate.getHours())}:${pad(bucketDate.getMinutes())}:00`;
      setChartData((current) => current.some((entry) => entry.bucket === bucket)
        ? current.map((entry) => entry.bucket === bucket ? { ...entry, count: entry.count + 1 } : entry)
        : [...current, { bucket, count: 1 }].sort((a, b) => a.bucket.localeCompare(b.bucket)));
    }
  }, [addPendingFields, chartMode, id, isToday, loadDevice, resolvePending]);

  useEventStream(handleEvent);
  useVisibilityRefresh(useCallback(() => { loadDevice(); loadChart(); }, [loadDevice, loadChart]));

  useEffect(() => {
    if (!machineDisplayOpen) return;
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement) setMachineDisplayOpen(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [machineDisplayOpen]);

  const dayTotal = useMemo(() => chartData.reduce((sum, entry) => sum + (entry.count || 0), 0), [chartData]);
  const status = deviceStatus(device);
  const alert = incidentLabel(device?.active_incident, now, t);
  const piecesPerHour = liveRate(device, now);

  function shiftDay(delta) {
    const date = new Date(`${selectedDate}T12:00:00`);
    date.setDate(date.getDate() + delta);
    const pad = (value) => String(value).padStart(2, "0");
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    setSelectedDate(key > todayStr() ? todayStr() : key);
    setLiveTimestamps([]);
    setLiveEnergyPoints([]);
  }

  async function restartSetup() {
    setRestarting(true);
    try { await api.delete(`/devices/${id}`); router.push("/devices"); }
    catch { setRestarting(false); setRestartOpen(false); }
  }

  async function openMachineDisplay() {
    setMachineDisplayOpen(true);
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch { /* The overlay still fills the app window. */ }
    }
  }

  async function closeMachineDisplay() {
    setMachineDisplayOpen(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { /* The view is already closed. */ }
    }
  }

  if (loading) return <>{closeButton}<DeviceDetailSkeleton /></>;
  if (!device) return <p className="text-muted-foreground">{t("deviceDetail.notFound")}</p>;

  return (
    <>
      <DeviceSettingsView
        activeTab={activeTab}
        onTabChange={setActiveTab}
        header={<div className="flex items-center justify-between gap-3"><div className="flex items-center gap-3"><h1 className="text-[22px] font-semibold tracking-tight">{device.name}</h1><span className={`size-2 rounded-full ${alert ? "bg-amber-500" : STATUS_DOT[status]}`} title={alert || t(STATUS_LABEL[status])} /></div>{closeButton}</div>}
        overviewSlot={status === "provisioning" ? (
          <section className="rounded-xl border bg-card px-6 py-8"><DeviceSetupAnimation createdAt={device.created_at} onRestartSetup={() => setRestartOpen(true)} /></section>
        ) : (
          <>
            <div className="mb-5 flex items-center justify-center text-sm text-muted-foreground"><button onClick={() => shiftDay(-1)} className="grid size-7 place-items-center rounded-md hover:bg-muted/60"><ChevronLeft className="size-4" /></button><span className="w-48 text-center">{new Date(`${selectedDate}T12:00:00`).toLocaleDateString(intlLocale, { weekday: "long", day: "numeric", month: "long" })}</span><button onClick={() => shiftDay(1)} disabled={isToday} className="grid size-7 place-items-center rounded-md hover:bg-muted/60 disabled:opacity-30"><ChevronRight className="size-4" /></button><button onClick={() => { setSelectedDate(todayStr()); setLiveTimestamps([]); setLiveEnergyPoints([]); }} className={`ml-1 rounded-md border px-2 py-0.5 text-xs ${isToday ? "invisible" : ""}`}>{t("deviceDetail.today")}</button></div>
            {isToday && (
              <div className="mb-7">
                <ProductionCounterPanel
                  device={device}
                  now={now}
                  canEdit={canEdit}
                  onProductionChanged={(production) => setDevice((current) => current ? { ...current, production } : current)}
                  onOpenMachineDisplay={openMachineDisplay}
                />
              </div>
            )}
            <section className="grid grid-cols-[max-content_max-content] items-baseline gap-x-8 sm:grid-cols-[max-content_max-content_max-content]">
              <div className="col-start-1 row-start-1 text-label">{isToday ? t("deviceDetail.today") : t("deviceDetail.display.pieces")}</div>
              {isToday && piecesPerHour != null && <div className="col-start-2 row-start-1 text-label">{t("deviceDetail.summary.rate")}</div>}
              <AnimatedCounter value={isToday ? device.count_today || 0 : dayTotal} className="col-start-1 row-start-2 text-display leading-none" animateOnMount />
              {isToday && piecesPerHour != null && <div className="col-start-2 row-start-2 text-counter tabular-nums text-muted-foreground">{piecesPerHour}/h</div>}
              {alert && isToday && <div className="col-span-2 row-start-3 mt-3 rounded-full border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-700 sm:col-span-1 sm:col-start-3 sm:row-start-2 sm:mt-0 sm:self-center dark:text-amber-400">{alert}</div>}
            </section>
            <RhythmOverview
              deviceId={id}
              selectedDate={selectedDate}
              liveTimestamps={isToday ? liveTimestamps : []}
              liveEnergyPoints={isToday ? liveEnergyPoints : []}
            />
            <section className="mt-6">{chartLoaded ? <DayChart mode={chartMode} onModeChange={setChartMode} data={chartData} weekData={weekData} monthData={monthData} selectionKey={selectedDate} /> : <ChartSkeleton />}</section>
            <p className="mt-6 text-sm text-muted-foreground">{t("deviceDetail.lastContact", { time: formatRelative(device.last_seen_at, now, t) })}</p>
          </>
        )}
        device={device}
        onConfigChanged={(patch) => setDevice((current) => ({ ...current, ...patch }))}
        onSettingSaved={(field, value) => addPending(field, value)}
        onSettingError={(fields, message) => markFailed(fields, message)}
        lastCommandEvent={lastCommandEvent}
        onClearPendingSettings={clearAll}
        settingsStatusSlot={<PendingSettingsBreadcrumb status={settingsStatus} onDismiss={dismissStatus} showIdle={activeTab === "config"} />}
        hasSettingsStatus={Boolean(settingsStatus)}
      />
      {machineDisplayOpen && <MachineCounterDisplay device={device} onClose={closeMachineDisplay} />}
      <Dialog open={restartOpen} onOpenChange={(open) => !restarting && setRestartOpen(open)}><DialogContent><DialogHeader><DialogTitle>{t("deviceDetail.restart.title")}</DialogTitle><DialogDescription>{t("deviceDetail.restart.description")}</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRestartOpen(false)} disabled={restarting}>{t("deviceDetail.cancel")}</Button><Button variant="destructive" onClick={restartSetup} disabled={restarting}>{restarting ? t("deviceDetail.restart.removing") : t("deviceDetail.restart.confirm")}</Button></DialogFooter></DialogContent></Dialog>
    </>
  );
}
