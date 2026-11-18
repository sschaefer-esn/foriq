"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Expand, Minimize2, MonitorUp } from "lucide-react";
import AnimatedCounter from "@/components/ui/AnimatedCounter";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import useNow from "@/hooks/useNow";
import { deviceStatus } from "@/lib/deviceStatus";
import { formatCount, productionMetrics } from "@/lib/productionCounter";
import { liveRate } from "@/lib/stall";
import { useLocale, useT } from "@/lib/i18n";

const STATUS_LABEL = {
  online: "deviceDetail.monitor.status.online",
  sleeping: "deviceDetail.monitor.status.sleeping",
  provisioning: "deviceDetail.monitor.status.provisioning",
  offline: "deviceDetail.monitor.status.offline",
};

const STATUS_DOT = {
  online: "bg-emerald-400 animate-[pulse-online_2s_ease-in-out_infinite]",
  sleeping: "bg-amber-400",
  provisioning: "bg-amber-400",
  offline: "bg-white/20",
};

const subscribeToHydration = () => () => {};
const getClientHydrationSnapshot = () => true;
const getServerHydrationSnapshot = () => false;

function gridClass(count) {
  if (count <= 1) return "mx-auto max-w-4xl grid-cols-1";
  if (count <= 4) return "md:grid-cols-2";
  if (count <= 6) return "md:grid-cols-2 xl:grid-cols-3";
  return "sm:grid-cols-2 xl:grid-cols-4";
}

function MonitorCard({ device, now }) {
  const t = useT();
  const status = deviceStatus(device);
  const metrics = productionMetrics(device, now);
  const rate = metrics?.rate ?? liveRate(device, now);
  const current = metrics?.current ?? (device.count_today || 0);
  const complete = metrics?.remaining === 0;

  return (
    <article className="flex min-h-[210px] flex-col overflow-hidden rounded-xl border border-white/10 bg-[#0d1117] shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
      <header className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-[clamp(1rem,1.5vw,1.5rem)] py-3 [@media(max-height:800px)]:py-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[clamp(1rem,1.5vw,1.35rem)] font-semibold tracking-tight">{device.name || t("deviceDetail.machineFallback")}</h2>
            <span className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} />
          </div>
          <div className="mt-1 text-[0.68rem] font-medium uppercase tracking-[0.15em] text-white/38 [@media(max-height:800px)]:hidden">{t(STATUS_LABEL[status])}</div>
        </div>
        {metrics && (
          <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] ${complete ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-[#e24a3b]/25 bg-[#e24a3b]/10 text-[#ef796d]"}`}>
            {complete ? t("deviceDetail.projection.complete") : t("deviceDetail.monitor.targetRunning")}
          </span>
        )}
      </header>

      <div className="flex flex-1 flex-col px-[clamp(1rem,1.5vw,1.5rem)] py-3 [@media(max-height:800px)]:py-2">
        <div className="flex flex-1 items-end justify-between gap-5">
          <div className="min-w-0">
            <div className="text-[0.65rem] font-medium uppercase tracking-[0.17em] text-white/35">
              {metrics ? t("deviceDetail.monitor.sinceStart") : t("deviceDetail.monitor.today")}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <AnimatedCounter value={current} className="text-[clamp(3.2rem,6vw,6.8rem)] font-medium leading-[0.78] tracking-[-0.03em] in-data-[font=clash]:tracking-[-0.06em] tabular-nums" animateOnMount />
              <span className="text-[0.72rem] text-white/35">{t("deviceDetail.display.pieces")}</span>
            </div>
          </div>
          <div className="shrink-0 pb-0.5 text-right">
            <div className="text-[0.62rem] font-medium uppercase tracking-[0.15em] text-white/30">{t("deviceDetail.summary.rate")}</div>
            <div className="mt-1 text-[clamp(1.25rem,2.2vw,2rem)] font-medium leading-none tabular-nums text-white/75">{rate == null ? "–" : formatCount(rate)}</div>
            <div className="mt-1 text-[0.62rem] text-white/28">{t("deviceDetail.monitor.piecesPerHourShort")}</div>
          </div>
        </div>

        {metrics ? (
          <div className="mt-4 border-t border-white/[0.07] pt-3 [@media(max-height:800px)]:mt-2 [@media(max-height:800px)]:pt-2">
            <div className="mb-2 flex items-end justify-between gap-4">
              <div>
                <div className="text-[0.62rem] font-medium uppercase tracking-[0.15em] text-white/30">{t("deviceDetail.monitor.target")}</div>
                <div className="mt-1 text-sm font-medium tabular-nums text-white/72">{t("deviceDetail.display.targetPieces", { count: formatCount(metrics.target) })}</div>
              </div>
              <div className="text-right">
                <div className={`text-sm font-medium tabular-nums ${complete ? "text-emerald-300" : "text-white/72"}`}>{Math.round(metrics.progress)} %</div>
                <div className="mt-1 text-[0.62rem] text-white/30">{t("deviceDetail.display.remainingCount", { count: formatCount(metrics.remaining) })}</div>
              </div>
            </div>
            <div className="machine-display-rail relative h-3 overflow-hidden rounded-sm bg-white/[0.07]">
              <div className={`h-full transition-[width] duration-500 ${complete ? "bg-emerald-400" : "bg-[#e24a3b]"}`} style={{ width: `${metrics.progress}%` }} />
              <span className="absolute inset-y-[-0.2rem] w-0.5 bg-white shadow-[0_0_12px_rgba(255,255,255,0.7)] transition-[left] duration-500" style={{ left: `calc(${metrics.progress}% - 1px)` }} />
            </div>
            {metrics.materialRemaining != null && (
              <div className={`mt-1.5 text-[0.65rem] tabular-nums [@media(max-height:800px)]:hidden ${metrics.materialShortfall > 0 ? "text-amber-300/80" : "text-white/28"}`}>
                {t("deviceDetail.monitor.materialRemaining", { count: formatCount(metrics.materialRemaining) })}
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 border-t border-white/[0.07] pt-3 text-[0.65rem] uppercase tracking-[0.13em] text-white/24 [@media(max-height:800px)]:mt-2 [@media(max-height:800px)]:pt-2">
            {t("deviceDetail.monitor.noTarget")}
          </div>
        )}
      </div>
    </article>
  );
}

export function FleetMonitorView({ devices, loading = false }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const router = useRouter();
  const now = useNow(1000);
  const wasFullscreen = useRef(false);
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot
  );
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    wasFullscreen.current = Boolean(document.fullscreenElement);

    function handleFullscreenChange() {
      if (document.fullscreenElement) {
        wasFullscreen.current = true;
      } else if (wasFullscreen.current) {
        router.replace("/dashboard");
      }
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [router]);

  const visibleDevices = useMemo(() => {
    const filtered = showAll
      ? devices
      : devices.filter((device) => (device.count_today || 0) > 0 || device.production);
    return [...filtered].sort((a, b) => {
      if (Boolean(a.production) !== Boolean(b.production)) return a.production ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "", intlLocale, { numeric: true });
    });
  }, [devices, showAll, intlLocale]);

  async function enterFullscreen() {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch { /* The app view still fills the screen. */ }
    }
  }

  async function closeMonitor() {
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { /* Navigating away closes the view anyway. */ }
    }
    router.replace("/dashboard");
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex flex-col overflow-hidden bg-[#090c10] text-[#f4f6f8]">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-white/10 px-[clamp(1rem,2.5vw,2.5rem)] py-[clamp(0.85rem,1.8vh,1.4rem)]">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.035] text-white/70">
            <MonitorUp className="size-5" strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[clamp(1.15rem,2vw,1.7rem)] font-semibold tracking-tight">{t("deviceDetail.monitor.title")}</h1>
            <div className="mt-0.5 flex items-center gap-2 text-[0.65rem] uppercase tracking-[0.15em] text-white/35">
              <span className="size-1.5 animate-[pulse-online_2s_ease-in-out_infinite] rounded-full bg-emerald-400" />
              {t("deviceDetail.monitor.liveCount", { count: visibleDevices.length })}
            </div>
          </div>
        </div>

        <div className="order-3 flex w-full items-center justify-between gap-3 sm:order-none sm:w-auto sm:justify-start">
          <div className="flex rounded-lg border border-white/10 bg-white/[0.025] p-1" role="group" aria-label={t("deviceDetail.monitor.filterLabel")}>
            <button type="button" aria-pressed={!showAll} onClick={() => setShowAll(false)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${!showAll ? "bg-white/10 text-white" : "text-white/42 hover:text-white/70"}`}>{t("deviceDetail.monitor.activeToday")}</button>
            <button type="button" aria-pressed={showAll} onClick={() => setShowAll(true)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${showAll ? "bg-white/10 text-white" : "text-white/42 hover:text-white/70"}`}>{t("deviceDetail.monitor.all")}</button>
          </div>
        </div>

        <div className="hidden text-right md:block">
          <time className="block text-[clamp(1.15rem,2vw,1.65rem)] font-medium leading-none tabular-nums">
            {new Date(now).toLocaleTimeString(intlLocale, { hour: "2-digit", minute: "2-digit" })}
          </time>
          <span className="mt-1 block text-[0.65rem] uppercase tracking-[0.13em] text-white/30">
            {new Date(now).toLocaleDateString(intlLocale, { weekday: "short", day: "2-digit", month: "short" })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={enterFullscreen} aria-label={t("deviceDetail.monitor.fullscreen")} title={t("deviceDetail.monitor.fullscreen")} className="grid size-10 place-items-center rounded-lg border border-white/12 bg-white/[0.035] text-white/65 transition hover:bg-white/[0.08] hover:text-white focus-visible:ring-2 focus-visible:ring-white/50">
            <Expand className="size-[18px]" />
          </button>
          <button type="button" onClick={closeMonitor} aria-label={t("deviceDetail.monitor.close")} title={t("deviceDetail.monitor.close")} className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/12 bg-white/[0.035] px-3.5 text-sm font-medium text-white/72 transition hover:bg-white/[0.08] hover:text-white focus-visible:ring-2 focus-visible:ring-white/50">
            <Minimize2 className="size-[18px]" />
            <span className="hidden lg:inline">{t("deviceDetail.monitor.closeShort")}</span>
          </button>
        </div>
      </header>

      <section aria-label={t("deviceDetail.monitor.overview")} className="flex min-h-0 flex-1 overflow-auto p-[clamp(0.75rem,1.6vw,1.5rem)]">
        {loading ? (
          <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => <div key={index} className="min-h-[230px] animate-[foriq-skeleton_1.8s_ease-in-out_infinite] rounded-xl border border-white/[0.06] bg-white/[0.035]" />)}
          </div>
        ) : visibleDevices.length ? (
          <div className={`grid flex-1 auto-rows-fr gap-[clamp(0.6rem,1vw,1rem)] ${gridClass(visibleDevices.length)}`}>
            {visibleDevices.map((device) => <MonitorCard key={device.id} device={device} now={now} />)}
          </div>
        ) : (
          <div className="grid flex-1 place-items-center text-center">
            <div>
              <MonitorUp className="mx-auto size-9 text-white/18" strokeWidth={1.5} />
              <h2 className="mt-4 text-lg font-medium">{t("deviceDetail.monitor.emptyTitle")}</h2>
              <p className="mt-1 text-sm text-white/38">{t("deviceDetail.monitor.emptyText")}</p>
              <button type="button" onClick={() => setShowAll(true)} className="mt-5 rounded-lg border border-white/12 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/72 transition hover:bg-white/[0.09] hover:text-white">{t("deviceDetail.monitor.showAll")}</button>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body
  );
}

export default function FleetMonitor() {
  const fleet = useFleetLive();
  return <FleetMonitorView devices={fleet.devices} loading={fleet.loading} />;
}
