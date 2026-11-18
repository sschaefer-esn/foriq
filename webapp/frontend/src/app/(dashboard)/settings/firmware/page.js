"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import useEventStream from "@/hooks/useEventStream";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

const DEFAULT_TARGET = "m5sticks3";

// Running update phases (subset of device_commands.progress) → dictionary key.
const PHASE_LABEL_KEYS = {
  pending: "settings.firmware.phase.waiting",
  delivered: "settings.firmware.phase.waiting",
  downloading: "settings.firmware.phase.downloading",
  installing: "settings.firmware.phase.installing",
  restarting: "settings.firmware.phase.restarting",
};

function relativeTime(iso, t) {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return t("settings.firmware.ago.justNow");
  if (mins < 60) return t("settings.firmware.ago.minutes", { count: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("settings.firmware.ago.hours", { count: hours });
  return t("settings.firmware.ago.days", { count: Math.floor(hours / 24) });
}

export default function FirmwarePage() {
  // Server version per build target (/ota/version → targets); sensors without a
  // reported target are compared with the default target.
  const t = useT();
  const [targets, setTargets] = useState({});
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [vRes, dRes] = await Promise.all([
        api.get("/ota/version"),
        api.get("/devices"),
      ]);
      const rawTargets = vRes.data.targets || { [DEFAULT_TARGET]: vRes.data.version };
      setTargets(
        Object.fromEntries(
          Object.entries(rawTargets).map(([name, version]) => [
            name,
            version && version !== "unknown" ? version : null,
          ])
        )
      );
      setDevices(dRes.data);
      setError("");
    } catch {
      // Without the server version nothing can be said — this must be visible,
      // otherwise every sensor silently appears "outdated".
      setError(t("settings.firmware.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  // Follow running updates live (phase changes, timeout, completion).
  useEventStream(
    useCallback(
      (event) => {
        if (event.type === "command_status" && event.data?.command === "ota_update") {
          load();
        }
      },
      [load]
    )
  );

  const serverVersionFor = (d) => targets[d.firmware_target || DEFAULT_TARGET] ?? null;
  const upToDateCount = devices.filter(
    (d) => d.firmware_version && d.firmware_version === serverVersionFor(d)
  ).length;
  const versions = [...new Set(Object.values(targets).filter(Boolean))];

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("settings.firmware.title")}</h1>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          <span className="ml-1">{t("settings.firmware.refresh")}</span>
        </Button>
      </div>

      {versions.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {t("settings.firmware.serverVersion", { versions: versions.map((v) => `v${v}`).join(" / ") })}
        </p>
      )}

      {error && (
        <p className="mt-4 flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="size-4" />
          {error}
        </p>
      )}

      {devices.length > 0 && (
        <div className="mt-6 max-w-2xl">
          <h3 className="text-sm font-semibold mb-3">{t("settings.firmware.deviceStatus")}</h3>

          {upToDateCount > 0 && (
            <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-2 mb-3">
              <Check className="size-4" />
              {t("settings.firmware.upToDate", { upToDate: upToDateCount, count: devices.length })}
            </p>
          )}

          <div className="rounded-xl border border-border/60 bg-card shadow-card divide-y">
            {devices.map((d) => {
              const target = serverVersionFor(d);
              const isCurrent = !!target && !!d.firmware_version && d.firmware_version === target;
              const isUnknown = !d.firmware_version;
              const releaseUnavailable = !target;
              const seen = relativeTime(d.last_seen_at, t);
              return (
                <div key={d.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate">{d.name}</span>
                      {d.auto_update && (
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                          {t("settings.firmware.auto")}
                        </span>
                      )}
                    </div>
                    <span
                      className={
                        isCurrent
                          ? "text-green-600 dark:text-green-400 shrink-0"
                          : isUnknown || releaseUnavailable
                            ? "text-muted-foreground shrink-0"
                            : "text-orange-500 shrink-0"
                      }
                    >
                      {isUnknown ? "–" : `v${d.firmware_version}`}
                      {!isCurrent && !isUnknown && target && (
                        <span className="ml-1 text-xs">→ v{target}</span>
                      )}
                      {!isUnknown && releaseUnavailable && (
                        <span className="ml-1 text-xs">· {t("settings.firmware.noRelease")}</span>
                      )}
                    </span>
                  </div>

                  {(d.active_ota || d.ota_retry || seen) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {d.active_ota && (
                        <span className="text-blue-600 dark:text-blue-400">
                          {t("settings.firmware.updateRunning", {
                            phase: PHASE_LABEL_KEYS[d.active_ota.progress || d.active_ota.status]
                              ? t(PHASE_LABEL_KEYS[d.active_ota.progress || d.active_ota.status])
                              : d.active_ota.progress ?? d.active_ota.status,
                          })}
                        </span>
                      )}
                      {d.ota_retry && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {t("settings.firmware.failedAttempts", { count: d.ota_retry.fail_count })}
                          {d.ota_retry.last_error ? ` (${d.ota_retry.last_error})` : ""}
                        </span>
                      )}
                      {seen && <span>{t("settings.firmware.lastSeen", { when: seen })}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
