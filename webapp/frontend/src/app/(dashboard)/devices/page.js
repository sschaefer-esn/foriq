"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { motion } from "framer-motion";
import { MonitorSmartphone, RotateCw } from "lucide-react";
import api from "@/lib/api";
import { fadeRise, staggerContainer } from "@/lib/motion";
import DeviceCard from "@/components/devices/DeviceCard";
import PendingDevices from "@/components/devices/PendingDevices";
import { DashboardCardSkeleton } from "@/components/ui/Skeleton";
import EmptyState from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/button";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import { useLocale, useT } from "@/lib/i18n";

const DAYS = [
  { id: 1, labelKey: "devices.weekday.mon" }, { id: 2, labelKey: "devices.weekday.tue" }, { id: 3, labelKey: "devices.weekday.wed" },
  { id: 4, labelKey: "devices.weekday.thu" }, { id: 5, labelKey: "devices.weekday.fri" }, { id: 6, labelKey: "devices.weekday.sat" }, { id: 7, labelKey: "devices.weekday.sun" },
];

export default function DevicesPage() {
  const fleet = useFleetLive();
  const t = useT();
  const { intlLocale } = useLocale();
  const { data: session } = useAuth();
  const canEdit = ["owner", "admin"].includes(session?.user?.role);
  const [restartEnabled, setRestartEnabled] = useState(null);
  const [restartDays, setRestartDays] = useState([1, 2, 3, 4, 5]);
  const [restartTime, setRestartTime] = useState("01:00");
  const [restartLoading, setRestartLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const restartToggleRef = useRef(null);
  const sortedDevices = useMemo(() => [...fleet.devices].sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", intlLocale, { numeric: true, sensitivity: "base" })
  ), [fleet.devices, intlLocale]);

  const fleetDeviceKey = fleet.devices.map((device) => device.id).sort().join(",");

  const loadRestartPlans = useCallback(async (silent = false) => {
    setRestartLoading(true);
    await api.get("/devices").then(({ data }) => {
      const plans = data.map((device) => device.restart_schedule || null);
      const signatures = new Set(plans.map((plan) => JSON.stringify(plan)));
      if (signatures.size > 1) {
        setRestartEnabled(null);
        if (!silent) setMessage(t("devices.restart.mixed"));
      } else {
        const plan = plans[0];
        setRestartEnabled(Boolean(plan));
        if (plan) {
          setRestartDays(plan.days || []);
          setRestartTime(plan.time || "01:00");
        }
      }
    }).catch(() => {
      if (!silent) setMessage(t("devices.restart.loadFailed"));
    }).finally(() => {
      setRestartLoading(false);
    });
  }, [t]);

  useEffect(() => {
    const timer = setTimeout(() => { loadRestartPlans(); }, 0);
    return () => clearTimeout(timer);
  }, [fleetDeviceKey, loadRestartPlans]);

  useEffect(() => {
    if (restartToggleRef.current) restartToggleRef.current.indeterminate = restartEnabled === null;
  }, [restartEnabled]);

  async function saveRestartPlan() {
    if (restartEnabled === null) {
      setMessage(t("devices.restart.chooseFirst"));
      return;
    }
    setSaving(true);
    setMessage("");
    const plan = restartEnabled ? { days: [...restartDays].sort(), time: restartTime, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } : null;
    const results = await Promise.allSettled(fleet.devices.map((device) => api.put(`/devices/${device.id}`, { restart_schedule: plan })));
    const failed = results.filter((result) => result.status === "rejected").length;
    await loadRestartPlans(true);
    setMessage(failed ? t("devices.restart.updateFailed", { count: failed }) : t("devices.restart.saved"));
    setSaving(false);
  }

  return (
    <div>
      <header className="flex items-end justify-between gap-4">
        <div><h1 className="text-[22px] font-semibold tracking-tight">{t("devices.page.title")}</h1><p className="mt-1 text-sm text-muted-foreground">{t("devices.page.subtitle")}</p></div>
      </header>

      {canEdit && <PendingDevices onApproved={fleet.refresh} />}

      {canEdit && fleet.devices.length > 0 && (
        <section className="mt-5 max-w-3xl rounded-xl border border-border/60 bg-card p-4 shadow-card">
          <div className="flex items-start justify-between gap-4"><div className="flex gap-2"><RotateCw className="mt-0.5 size-4 text-muted-foreground" /><div><h2 className="text-sm font-medium">{t("devices.restart.title")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("devices.restart.subtitle")}</p></div></div><label className="flex items-center gap-2 text-sm"><input ref={restartToggleRef} type="checkbox" checked={restartEnabled === true} disabled={restartLoading} onChange={(event) => { setRestartEnabled(event.target.checked); setMessage(""); }} />{restartEnabled === null ? t("devices.restart.mixedLabel") : t("devices.restart.active")}</label></div>
          {restartEnabled && <div className="mt-4 flex flex-wrap items-center gap-3"><div className="flex gap-1">{DAYS.map((day) => { const active = restartDays.includes(day.id); return <button key={day.id} onClick={() => setRestartDays((current) => active ? current.filter((id) => id !== day.id) : [...current, day.id])} className={`rounded-md px-2 py-1 text-xs ${active ? "bg-foreground text-background" : "border text-muted-foreground"}`}>{t(day.labelKey)}</button>; })}</div><input type="time" value={restartTime} onChange={(event) => setRestartTime(event.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" /></div>}
          <div className="mt-4 flex items-center gap-3"><Button size="sm" onClick={saveRestartPlan} disabled={restartLoading || saving || restartEnabled === null || (restartEnabled && !restartDays.length)}>{saving ? t("devices.restart.saving") : t("devices.restart.saveAll")}</Button>{message && <span className="text-xs text-muted-foreground">{message}</span>}</div>
        </section>
      )}

      <div className="mt-6">
        {fleet.loading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <DashboardCardSkeleton key={index} />)}</div>
          : fleet.devices.length === 0 ? <EmptyState icon={MonitorSmartphone} title={t("devices.empty.title")} subtitle={t("devices.empty.subtitle")} />
          : <motion.div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" variants={staggerContainer} initial="hidden" animate="visible">{sortedDevices.map((device) => <motion.div key={device.id} variants={fadeRise}><DeviceCard device={device} /></motion.div>)}</motion.div>}
      </div>
    </div>
  );
}
