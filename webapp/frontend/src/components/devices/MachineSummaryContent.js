"use client";

import AnimatedCounter from "@/components/ui/AnimatedCounter";
import useNow from "@/hooks/useNow";
import { deviceStatus } from "@/lib/deviceStatus";
import { liveRate } from "@/lib/stall";
import { formatCount } from "@/lib/productionCounter";
import { useT } from "@/lib/i18n";

const STATUS_LABEL = {
  online: "deviceDetail.summary.status.online",
  sleeping: "deviceDetail.summary.status.sleeping",
  provisioning: "deviceDetail.summary.status.provisioning",
  offline: "deviceDetail.summary.status.offline",
};

const STATUS_DOT = {
  online: "bg-emerald-500 animate-[pulse-online_2s_ease-in-out_infinite]",
  sleeping: "bg-amber-400",
  provisioning: "bg-amber-500",
  offline: "bg-muted-foreground/40",
};

function incidentLabel(incident, now, t) {
  if (!incident?.condition_since_at) return null;
  const minutes = Math.max(0, Math.floor((now - new Date(incident.condition_since_at).getTime()) / 60000));
  const duration = minutes < 60
    ? t("deviceDetail.summary.durationMinutes", { minutes })
    : t("deviceDetail.summary.durationHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  return incident.type === "device_offline"
    ? t("deviceDetail.summary.incidentOffline", { duration })
    : t("deviceDetail.summary.incidentStall", { duration });
}

export default function MachineSummaryContent({ device, isToday = true }) {
  const t = useT();
  const now = useNow(30000);
  const status = deviceStatus(device);
  const rate = isToday ? liveRate(device, now) : null;
  const incident = isToday ? incidentLabel(device?.active_incident, now, t) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center">
      <div className="min-w-0">
        <h3 className="truncate font-medium text-foreground">
          {device?.name || device?.device_name || t("deviceDetail.machineFallback")}
        </h3>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={`size-1.5 shrink-0 rounded-full ${incident ? "bg-amber-500" : STATUS_DOT[status]}`} />
          <span className={incident ? "truncate font-medium text-amber-600 dark:text-amber-400" : "truncate"}>
            {incident || t(STATUS_LABEL[status])}
          </span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-muted/40 px-2.5 py-2 text-center">
          <div className="text-label">{isToday ? t("deviceDetail.summary.today") : t("deviceDetail.summary.pieces")}</div>
          <div className="mt-0.5 text-lg font-medium tabular-nums">
            <AnimatedCounter value={device?.count_today ?? 0} />
          </div>
        </div>
        <div className="rounded-lg bg-muted/40 px-2.5 py-2 text-center">
          <div className="text-label">{t("deviceDetail.summary.rate")}</div>
          <div className="mt-0.5 text-lg font-medium tabular-nums">{rate != null ? `${rate}/h` : "–"}</div>
        </div>
      </div>
      {isToday && device?.production && (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium">{t("deviceDetail.productionTarget")}</span>
            <span className="tabular-nums text-muted-foreground">
              {formatCount(device.production.current_count)} / {formatCount(device.production.target_count)}
            </span>
          </div>
          <div className="machine-progress-track mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${device.production.current_count >= device.production.target_count ? "bg-emerald-500" : "bg-primary"}`}
              style={{ width: `${Math.min(100, Math.max(0, (device.production.current_count / device.production.target_count) * 100))}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
