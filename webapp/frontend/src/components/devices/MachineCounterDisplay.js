"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Minimize2 } from "lucide-react";
import AnimatedCounter from "@/components/ui/AnimatedCounter";
import useNow from "@/hooks/useNow";
import { deviceStatus } from "@/lib/deviceStatus";
import { formatCount, formatEta, productionMetrics } from "@/lib/productionCounter";
import { liveRate } from "@/lib/stall";
import { useLocale, useT } from "@/lib/i18n";

const STATUS_LABEL = {
  online: "deviceDetail.display.status.online",
  sleeping: "deviceDetail.display.status.sleeping",
  provisioning: "deviceDetail.display.status.provisioning",
  offline: "deviceDetail.display.status.offline",
};

function projectionValue(metrics, now, t) {
  if (!metrics) return t("deviceDetail.projection.noTarget");
  if (metrics.projectionStatus === "complete") return t("deviceDetail.projection.complete");
  if (metrics.projectionStatus === "available") return formatEta(metrics.etaAt, now);
  if (metrics.projectionStatus === "too_long") return t("deviceDetail.projection.tooLong");
  if (metrics.projectionStatus === "stale") return t("deviceDetail.projection.stale");
  return t("deviceDetail.projection.pending");
}

export default function MachineCounterDisplay({ device, onClose }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const now = useNow(1000);
  const status = deviceStatus(device);
  const metrics = productionMetrics(device, now);
  const current = metrics?.current ?? (device?.count_today || 0);
  const rate = metrics?.rate ?? liveRate(device, now);
  const complete = metrics?.remaining === 0;

  useEffect(() => {
    const handleKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={t("deviceDetail.display.ariaLabel", { name: device?.name || t("deviceDetail.machineFallback") })} className="fixed inset-0 z-[10000] overflow-auto bg-[#090c10] text-[#f4f6f8]">
      <div className="flex min-h-full flex-col px-[clamp(1rem,3vw,3rem)] py-[clamp(1rem,2.5vw,2.5rem)]">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-[clamp(0.8rem,2vh,1.5rem)]">
          <div className="min-w-0">
            <div className="truncate text-[clamp(1.1rem,2.4vw,2rem)] font-semibold tracking-tight">{device?.name || t("deviceDetail.machineFallback")}</div>
            <div className="mt-1 flex items-center gap-2 text-[clamp(0.7rem,1.2vw,0.95rem)] uppercase tracking-[0.14em] text-white/50">
              <span className={`size-2 rounded-full ${status === "online" ? "animate-[pulse-online_2s_ease-in-out_infinite] bg-emerald-400" : status === "sleeping" ? "bg-amber-400" : "bg-white/25"}`} />
              {t(STATUS_LABEL[status])}
            </div>
          </div>
          <div className="flex items-center gap-[clamp(0.8rem,2vw,2rem)]">
            <time className="hidden text-[clamp(1.2rem,2.2vw,1.8rem)] font-medium tabular-nums text-white/70 sm:block">
              {new Date(now).toLocaleTimeString(intlLocale, { hour: "2-digit", minute: "2-digit" })}
            </time>
            <button type="button" onClick={onClose} aria-label={t("deviceDetail.display.close")} title={t("deviceDetail.display.close")} className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-4 text-sm font-medium transition hover:bg-white/[0.09] focus-visible:ring-2 focus-visible:ring-white/60">
              <Minimize2 className="size-4" />
              <span className="hidden sm:inline">{t("deviceDetail.display.closeShort")}</span>
            </button>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col justify-center py-[clamp(1.25rem,4vh,4rem)]">
          <div className="grid items-end gap-[clamp(0.75rem,2vw,2rem)] lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,0.65fr)]">
            <section>
              <div className="text-[clamp(0.72rem,1.2vw,1rem)] font-medium uppercase tracking-[0.18em] text-white/45">
                {metrics ? t("deviceDetail.display.producedSinceStart") : t("deviceDetail.display.countedToday")}
              </div>
              <div className="mt-[clamp(0.4rem,1vh,1rem)] flex items-end gap-[clamp(0.75rem,2vw,2rem)]">
                <AnimatedCounter value={current} className="text-[clamp(6rem,19vw,18rem)] font-medium leading-[0.72] tracking-[-0.03em] in-data-[font=clash]:tracking-[-0.065em] tabular-nums" animateOnMount />
                <span className="pb-[clamp(0.35rem,2vw,2rem)] text-[clamp(1rem,2vw,1.8rem)] text-white/45">{t("deviceDetail.display.pieces")}</span>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10">
              <div className="bg-[#0d1117] p-[clamp(1rem,2vw,2rem)]">
                <div className="text-[clamp(0.65rem,0.9vw,0.8rem)] uppercase tracking-[0.16em] text-white/40">{t("deviceDetail.display.remaining")}</div>
                <div className="mt-2 text-[clamp(1.7rem,4vw,3.5rem)] font-medium leading-none tabular-nums">{metrics ? formatCount(metrics.remaining) : "–"}</div>
              </div>
              <div className="bg-[#0d1117] p-[clamp(1rem,2vw,2rem)]">
                <div className="text-[clamp(0.65rem,0.9vw,0.8rem)] uppercase tracking-[0.16em] text-white/40">{t("deviceDetail.display.material")}</div>
                <div className={`mt-2 text-[clamp(1.7rem,4vw,3.5rem)] font-medium leading-none tabular-nums ${metrics?.materialShortfall > 0 ? "text-amber-300" : ""}`}>{metrics?.materialRemaining == null ? "–" : formatCount(metrics.materialRemaining)}</div>
              </div>
              <div className="bg-[#0d1117] p-[clamp(1rem,2vw,2rem)]">
                <div className="text-[clamp(0.65rem,0.9vw,0.8rem)] uppercase tracking-[0.16em] text-white/40">{t("deviceDetail.display.currentRate")}</div>
                <div className="mt-2 text-[clamp(1.7rem,4vw,3.5rem)] font-medium leading-none tabular-nums">{rate != null ? formatCount(rate) : "–"}</div>
                <div className="mt-1 text-[clamp(0.65rem,1vw,0.85rem)] text-white/35">{t("deviceDetail.display.piecesPerHour")}</div>
              </div>
              <div className="bg-[#0d1117] p-[clamp(1rem,2vw,2rem)]">
                <div className="text-[clamp(0.65rem,0.9vw,0.8rem)] uppercase tracking-[0.16em] text-white/40">{t("deviceDetail.display.projection")}</div>
                <div className={`mt-2 text-[clamp(1.2rem,2.5vw,2.4rem)] font-medium leading-none tabular-nums ${complete ? "text-emerald-300" : ""}`}>{projectionValue(metrics, now, t)}</div>
                {metrics && <div className="mt-2 text-[clamp(0.6rem,0.9vw,0.78rem)] text-white/35">{t("deviceDetail.display.projectionHint")}</div>}
              </div>
            </section>
          </div>

          {metrics && (
            <section className="mt-[clamp(1.5rem,5vh,4.5rem)]">
              <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                  <div className="text-[clamp(0.65rem,0.9vw,0.8rem)] uppercase tracking-[0.16em] text-white/40">{t("deviceDetail.productionTarget")}</div>
                  <div className="mt-1 text-[clamp(1.1rem,2vw,1.7rem)] font-medium tabular-nums">{t("deviceDetail.display.targetPieces", { count: formatCount(metrics.target) })}</div>
                </div>
                <div className={`text-[clamp(1rem,1.6vw,1.4rem)] font-medium tabular-nums ${complete ? "text-emerald-300" : "text-white/65"}`}>{Math.round(metrics.progress)} %</div>
              </div>
              <div className="machine-display-rail relative h-[clamp(1.25rem,3vh,2rem)] overflow-hidden rounded-sm bg-white/[0.07]">
                <div className={`h-full transition-[width] duration-500 ${complete ? "bg-emerald-400" : "bg-[#e24a3b]"}`} style={{ width: `${metrics.progress}%` }} />
                <span className="absolute inset-y-[-0.35rem] w-1 bg-white shadow-[0_0_18px_rgba(255,255,255,0.8)] transition-[left] duration-500" style={{ left: `calc(${metrics.progress}% - 2px)` }} />
              </div>
              <div className="mt-3 flex justify-between text-[clamp(0.65rem,1vw,0.85rem)] uppercase tracking-[0.12em] text-white/30">
                <span>{t("deviceDetail.display.start")}</span>
                <span>{complete ? t("deviceDetail.display.overTarget", { count: formatCount(metrics.overTarget) }) : t("deviceDetail.display.remainingCount", { count: formatCount(metrics.remaining) })}</span>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>,
    document.body,
  );
}
