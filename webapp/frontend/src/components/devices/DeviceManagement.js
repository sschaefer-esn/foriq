"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import {
  RefreshCw,
  WifiOff,
  X,
  Download,
  Check,
  ArrowUpCircle,
  Trash2,
  Loader2,
  RotateCcw,
  KeyRound,
  AlertTriangle,
} from "lucide-react";
import api, { apiErrorMessage } from "@/lib/api";
import useNow from "@/hooks/useNow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { translate, useLocale, useT } from "@/lib/i18n";

const OTA_LABEL_KEYS = {
  pending: "devices.ota.pending",
  delivered: "devices.ota.delivered",
  downloading: "devices.ota.downloading",
  installing: "devices.ota.installing",
  restarting: "devices.ota.restarting",
  completed: "devices.ota.completed",
  cancelled: "devices.ota.cancelled",
  failed: "devices.ota.failed",
  timeout: "devices.ota.timeout",
  undelivered: "devices.ota.undelivered",
  superseded: "devices.ota.superseded",
};

// Elapsed time as "2:14 min" / "45 s" — answers the real question during a
// running update ("is it stuck?") better than a progress bar.
function formatElapsed(fromIso, nowMs, t) {
  if (!fromIso) return null;
  const secs = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000));
  if (secs < 60) return t("devices.elapsed.seconds", { s: secs });
  return t("devices.elapsed.minutes", { m: Math.floor(secs / 60), ss: String(secs % 60).padStart(2, "0") });
}

function getOtaLabel(progress, isSleeping, t) {
  if (isSleeping && (progress === "pending" || progress === "delivered")) {
    return t("devices.ota.sleeping");
  }
  return OTA_LABEL_KEYS[progress] ? t(OTA_LABEL_KEYS[progress]) : progress;
}

const WEEKDAYS = [
  { key: 1, labelKey: "devices.weekday.mon" },
  { key: 2, labelKey: "devices.weekday.tue" },
  { key: 3, labelKey: "devices.weekday.wed" },
  { key: 4, labelKey: "devices.weekday.thu" },
  { key: 5, labelKey: "devices.weekday.fri" },
  { key: 6, labelKey: "devices.weekday.sat" },
  { key: 7, labelKey: "devices.weekday.sun" },
];

export default function DeviceManagement({
  device,
  onDeviceChanged,
  sseEvent,
  onClearPendingSettings,
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const router = useRouter();
  const { data: session } = useAuth();
  // Viewers have no access to the Wi-Fi configuration (display + management).
  const isViewer = session?.user?.role === "viewer";
  const [confirmAction, setConfirmAction] = useState(null); // "restart" | "wifi_reset" | "delete"
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [commandStatus, setCommandStatus] = useState("");
  const [serverVersion, setServerVersion] = useState(null);
  const [checking, setChecking] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [otaProgress, setOtaProgress] = useState(null);
  const [otaError, setOtaError] = useState(null);
  const [setupPassword, setSetupPassword] = useState(null);
  // One-second tick so the elapsed time of an active update keeps running.
  const now = useNow(1000);
  // Automatic restart plan — like the auto-update toggle, saved immediately
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDays, setScheduleDays] = useState([]);
  const [scheduleTime, setScheduleTime] = useState("01:00");
  const onDeviceChangedRef = useRef(onDeviceChanged);
  useEffect(() => { onDeviceChangedRef.current = onDeviceChanged; }, [onDeviceChanged]);
  useEffect(() => {
    if (device?.restart_schedule) {
      setScheduleEnabled(true);
      setScheduleDays(device.restart_schedule.days ?? []);
      setScheduleTime(device.restart_schedule.time ?? "01:00");
    } else {
      setScheduleEnabled(false);
      setScheduleDays([]);
      setScheduleTime("01:00");
    }
  }, [device?.restart_schedule]);
  // Recover OTA progress from DB state on mount/page reload
  useEffect(() => {
    if (!device?.active_ota) return;
    const progress = device.active_ota.progress || device.active_ota.status;
    if (progress && progress !== "completed" && progress !== "failed") {
      setOtaProgress((current) => current || progress);
    }
  }, [device?.active_ota]);

  // Handle SSE events for command results
  useEffect(() => {
    if (!sseEvent) return;
    if (sseEvent.device_id !== device?.id) return;

    // OTA progress. The queue event (commands.py) only carries status, not
    // progress — without the fallback the UI swallowed the start of the update.
    if (sseEvent.command === "ota_update") {
      const progress = sseEvent.progress || sseEvent.status;
      if (!progress) return;
      setOtaProgress(progress);
      setOtaError(sseEvent.error || null);
      setCommandStatus("");

      if (progress === "completed") {
        const newVersion = sseEvent.firmware_version;
        const timer = setTimeout(() => {
          setOtaProgress(null);
          if (newVersion) {
            onDeviceChangedRef.current?.({ firmware_version: newVersion });
          }
          setServerVersion(null);
          setUpdateChecked(false);
        }, 3000);
        return () => clearTimeout(timer);
      }
      if (progress === "cancelled" || progress === "superseded") {
        const timer = setTimeout(() => setOtaProgress(null), 2000);
        return () => clearTimeout(timer);
      }
      if (["failed", "timeout", "undelivered"].includes(progress)) {
        const timer = setTimeout(() => {
          setOtaProgress(null);
          setOtaError(null);
          setServerVersion(null);
          setUpdateChecked(false);
        }, 8000);
        return () => clearTimeout(timer);
      }
      return;
    }

    // Setup password result (existing sensors: the answer arrives via an online command)
    if (sseEvent.command === "get_setup_password") {
      if (sseEvent.status === "completed" && sseEvent.result) {
        setSetupPassword(sseEvent.result);
        setCommandStatus("");
        setError("");
      } else if (sseEvent.status === "failed") {
        setError(translate("devices.manage.setupPasswordFailed"));
        setCommandStatus("");
      }
    }

    // Restart result
    if (sseEvent.command === "restart") {
      if (sseEvent.status === "completed") {
        setCommandStatus(translate("devices.manage.restarted"));
        setError("");
      }
    }
  }, [sseEvent, device?.id]);

  function checkForUpdates() {
    // Deliberately NO setOtaProgress(null): a running update must not be cleared
    // visually while it keeps running on the server. To abort there is the
    // cancel link or "Reset all commands".
    setChecking(true);
    setError("");
    setCommandStatus("");
    setUpdateChecked(false);
    api
      .get("/ota/version", { params: { target: device?.firmware_target || undefined } })
      .then((res) => {
        const version = res.data.version === "unknown" ? null : res.data.version;
        setServerVersion(version);
        setUpdateChecked(true);
        if (!version) {
          setError(t("devices.manage.noRelease"));
        } else if (!device?.firmware_version) {
          setCommandStatus(t("devices.manage.serverVersion", { version }));
        }
      })
      .catch(() => {
        setError(t("devices.manage.checkFailed"));
      })
      .finally(() => {
        setChecking(false);
      });
  }

  const isUpToDate =
    updateChecked &&
    serverVersion &&
    device?.firmware_version &&
    serverVersion === device.firmware_version;

  // Hide "Firmware is up to date" after 5 s
  useEffect(() => {
    if (!isUpToDate) return;
    const timer = setTimeout(() => setUpdateChecked(false), 5000);
    return () => clearTimeout(timer);
  }, [isUpToDate]);

  // Hide status messages: 30 s for running actions (text ends with "..." in every
  // language), 5 s for results
  useEffect(() => {
    if (!commandStatus) return;
    const delay = commandStatus.endsWith("...") ? 30000 : 5000;
    const timer = setTimeout(() => setCommandStatus(""), delay);
    return () => clearTimeout(timer);
  }, [commandStatus]);

  // Hide the waiting message as soon as the sensor sends a signal again
  useEffect(() => {
    if (!device?.last_seen_at) return;
    setCommandStatus((current) => current?.endsWith("...") ? "" : current);
  }, [device?.last_seen_at]);

  // Resolve "restarting" once the sensor reports WITH THE TARGET VERSION.
  // Without the version check a fallback to the old firmware also looked like
  // a success.
  useEffect(() => {
    if (!device?.last_seen_at) return;
    const target = device?.active_ota?.target_version;
    if (!target || device?.firmware_version === target) {
      setOtaProgress((current) => current === "restarting" ? null : current);
    }
  }, [device?.last_seen_at, device?.firmware_version, device?.active_ota?.target_version]);

  // No client watchdog any more: the process-wide reaper in the backend drives
  // every update into a terminal state and sends an SSE event — also for
  // sensors that never come back. A second timer in the browser contradicted
  // the server ("timed out" while the update was still running).

  const hasUpdate =
    updateChecked &&
    serverVersion &&
    device?.firmware_version &&
    serverVersion !== device.firmware_version;

  const noVersion = updateChecked && serverVersion && !device?.firmware_version;

  async function cancelOta() {
    try {
      await api.post(`/devices/${device.id}/commands/ota-cancel`);
      setOtaProgress(null);
      setServerVersion(null);
      setUpdateChecked(false);
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.cancelError")));
    }
  }

  async function resetAllCommands() {
    setLoading(true);
    setError("");
    setCommandStatus("");
    try {
      const res = await api.post(`/devices/${device.id}/commands/reset-all`);
      setOtaProgress(null);
      setServerVersion(null);
      setUpdateChecked(false);
      onClearPendingSettings?.();
      const count = res.data.cancelled_count;
      setCommandStatus(
        count > 0
          ? t("devices.manage.resetCount", { count })
          : t("devices.manage.noPending")
      );
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.resetError")));
    } finally {
      setLoading(false);
      setConfirmAction(null);
    }
  }

  async function sendCommand(endpoint, body = null) {
    setLoading(true);
    setError("");
    setCommandStatus("");
    if (endpoint === "ota-update") {
      setOtaProgress("pending");
    }
    try {
      const res = await api.post(
        `/devices/${device.id}/commands/${endpoint}`,
        body || undefined,
      );
      if (endpoint === "get-setup-password" && res.data?.setup_password) {
        // The password comes live from the sensor only and is never stored
        // on the server.
        setSetupPassword(res.data.setup_password);
        setLoading(false);
        setConfirmAction(null);
        return;
      }
      if (endpoint === "ota-update") {
        // There is already an open attempt — show its state instead of creating
        // a second row (the backend deduplicates, the DB enforces it).
        if (res.data?.already_queued) {
          setOtaProgress(res.data.progress || res.data.status || "pending");
        }
      } else if (endpoint === "restart") {
        setCommandStatus(t("devices.manage.restarting"));
      } else {
        setCommandStatus(t("devices.manage.commandSent"));
      }
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.sendError")));
      if (endpoint === "ota-update") setOtaProgress(null);
    } finally {
      setLoading(false);
      setConfirmAction(null);
    }
  }

  async function handleDelete() {
    setLoading(true);
    setError("");
    try {
      await api.delete(`/devices/${device.id}`);
      router.push("/devices");
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.deleteError")));
      setLoading(false);
      setConfirmAction(null);
    }
  }

  async function toggleAutoUpdate() {
    const newValue = !device?.auto_update;
    try {
      await api.put(`/devices/${device.id}`, { auto_update: newValue });
      onDeviceChanged?.({ auto_update: newValue });
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.saveError")));
    }
  }

  // Save the restart plan immediately (active without days → null = effectively off).
  async function commitSchedule(enabled, days, time) {
    const plan =
      enabled && days.length > 0
        ? { days: [...days].sort(), time, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }
        : null;
    try {
      await api.put(`/devices/${device.id}`, { restart_schedule: plan });
      onDeviceChanged?.({ restart_schedule: plan });
    } catch (err) {
      setError(apiErrorMessage(err, t("devices.manage.saveError")));
    }
  }
  function toggleSchedule() {
    const next = !scheduleEnabled;
    setScheduleEnabled(next);
    commitSchedule(next, scheduleDays, scheduleTime);
  }
  function toggleScheduleDay(day) {
    const next = scheduleDays.includes(day)
      ? scheduleDays.filter((d) => d !== day)
      : [...scheduleDays, day];
    setScheduleDays(next);
    commitSchedule(scheduleEnabled, next, scheduleTime);
  }
  function changeScheduleTime(time) {
    setScheduleTime(time);
    commitSchedule(scheduleEnabled, scheduleDays, time);
  }

  // Fetch the setup password live from the sensor; the result arrives via SSE.
  // ALWAYS fetched and shown before the Wi-Fi reset — otherwise the user faces
  // the setup portal without knowing the AP password.
  async function fetchSetupPassword() {
    if (setupPassword) return;
    try {
      const res = await api.post(
        `/devices/${device.id}/commands/get-setup-password`,
      );
      if (res.data?.setup_password) setSetupPassword(res.data.setup_password);
    } catch {
      // The dialog keeps showing "fetching" / button stays disabled
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card shadow-card p-6">
      <h3 className="text-lg font-semibold">{t("devices.manage.title")}</h3>

      {/* Firmware */}
      <div className="mt-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Firmware</span>
          <span className="font-medium">
            {device?.firmware_version
              ? `v${device.firmware_version}`
              : t("devices.manage.unknown")}
          </span>
        </div>

        {(device?.hit_drop_count > 0 || device?.hit_spiffs_write_errors > 0 || device?.hit_server_rejected_count > 0) && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" />{t("devices.manage.transferProblems")}
            </div>
            <p className="mt-1 text-xs opacity-80">
              {device?.hit_drop_count > 0 && t("devices.manage.dropped", { count: device.hit_drop_count })}
              {device?.hit_drop_count > 0 && device?.hit_spiffs_write_errors > 0 && " · "}
              {device?.hit_spiffs_write_errors > 0 && t("devices.manage.flashErrors", { count: device.hit_spiffs_write_errors })}
              {(device?.hit_drop_count > 0 || device?.hit_spiffs_write_errors > 0) && device?.hit_server_rejected_count > 0 && " · "}
              {device?.hit_server_rejected_count > 0 && t("devices.manage.serverRejected", { count: device.hit_server_rejected_count })}
            </p>
          </div>
        )}

        {(device?.wifi_rssi != null || device?.hit_last_upload_ms > 0 ||
          device?.hit_queue_ram_count > 0 || device?.hit_queue_flash_count > 0 ||
          device?.wifi_offline_s > 0 || device?.wifi_reconnect_count > 0 ||
          device?.wifi_roam_count > 0) && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {device?.wifi_rssi != null && <span>{t("devices.manage.wifiRssi", { rssi: device.wifi_rssi })}</span>}
            {(device?.hit_queue_ram_count > 0 || device?.hit_queue_flash_count > 0) && (
              <span>
                {t("devices.manage.queue", { count: (device.hit_queue_ram_count || 0) + (device.hit_queue_flash_count || 0) })}
                {device?.hit_queue_oldest_age_s > 0 && t("devices.manage.queueOldest", { s: device.hit_queue_oldest_age_s })}
              </span>
            )}
            {device?.hit_last_upload_ms > 0 && <span>{t("devices.manage.lastUpload", { ms: device.hit_last_upload_ms })}</span>}
            {device?.hit_max_upload_ms > 0 && <span>{t("devices.manage.maxUpload", { ms: device.hit_max_upload_ms })}</span>}
            {device?.hit_http_error_count > 0 && <span>{t("devices.manage.httpErrors", { count: device.hit_http_error_count })}</span>}
            {device?.wifi_offline_s > 0 && <span>{t("devices.manage.wifiOutage", { s: device.wifi_offline_s })}</span>}
            {device?.wifi_reconnect_count > 0 && <span>{t("devices.manage.reconnects", { count: device.wifi_reconnect_count })}</span>}
            {device?.wifi_roam_count > 0 && <span>{t("devices.manage.roams", { count: device.wifi_roam_count })}</span>}
          </div>
        )}

        {/* OTA Progress */}
        {otaProgress && (() => {
          const isTerminal = ["completed", "cancelled", "superseded", "failed",
                              "timeout", "undelivered"].includes(otaProgress);
          const isError = ["failed", "timeout", "undelivered"].includes(otaProgress);
          const elapsed = formatElapsed(device?.active_ota?.last_progress_at, now, t);
          const seenAgo = formatElapsed(device?.last_seen_at, now, t);
          return (
          <div
            className={`rounded-md px-3 py-2 text-sm ${
              otaProgress === "completed"
                ? "bg-green-50 dark:bg-green-950/30 text-green-600 dark:text-green-400"
                : isError
                ? "bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400"
                : "bg-blue-50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {otaProgress === "completed" ? (
                  <Check className="size-4" />
                ) : isTerminal ? (
                  <X className="size-4" />
                ) : (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {getOtaLabel(otaProgress, device?.sleep_mode, t)}
              </div>
              {!isTerminal && (
                <button
                  className="text-xs text-muted-foreground hover:text-destructive underline"
                  onClick={cancelOta}
                >
                  {t("devices.manage.cancel")}
                </button>
              )}
            </div>
            {!isTerminal && (
              <p className="mt-1 text-xs opacity-70">
                {elapsed ? t("devices.ota.phaseSince", { elapsed }) : t("devices.ota.duration")}
                {seenAgo && t("devices.ota.lastSeen", { ago: seenAgo })}
              </p>
            )}
            {isError && otaError && (
              <p className="mt-1 text-xs opacity-80 font-mono break-all">{otaError}</p>
            )}
            {device?.active_ota?.command_id && (
              <p className="mt-1 text-[10px] opacity-40 font-mono">
                {device.active_ota.command_id}
              </p>
            )}
          </div>
          );
        })()}

        {/* Auto-update backs off after failed attempts — replaces the former block.
            Without this display a chronically failing sensor would go unnoticed. */}
        {!otaProgress && device?.ota_retry && (
          <div className="rounded-md bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            <div className="flex items-center justify-between gap-2">
              <span>
                v{device.ota_retry.target_version}: {t("devices.ota.failCount", { count: device.ota_retry.fail_count })}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => sendCommand("ota-update")}
                disabled={loading}
              >
                {t("devices.ota.retryNow")}
              </Button>
            </div>
            <p className="mt-1 text-xs opacity-80">
              {device.ota_retry.next_attempt_at
                ? t("devices.ota.nextAttempt", { time: new Date(
                    device.ota_retry.next_attempt_at
                  ).toLocaleString(intlLocale, { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) })
                : t("devices.ota.nextAttemptPending")}
              {device.ota_retry.last_error && t("devices.ota.lastError", { error: device.ota_retry.last_error })}
            </p>
          </div>
        )}

        {/* Update check result */}
        {!otaProgress && hasUpdate && (
          <div className="flex items-center justify-between rounded-md bg-orange-50 dark:bg-orange-950/30 px-3 py-2 text-sm">
            <span className="flex items-center gap-2 text-orange-600 dark:text-orange-400">
              <ArrowUpCircle className="size-4" />{t("devices.ota.available", { version: serverVersion })}
            </span>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => sendCommand("ota-update")}
              disabled={loading}
            >
              <Download className="size-3 mr-1" />
              {t("devices.ota.install")}
            </Button>
          </div>
        )}

        {!otaProgress && noVersion && serverVersion && (
          <div className="flex items-center justify-between rounded-md bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-sm">
            <span className="text-blue-600 dark:text-blue-400">
              {t("devices.ota.installable", { version: serverVersion })}
            </span>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => sendCommand("ota-update")}
              disabled={loading}
            >
              <Download className="size-3 mr-1" />
              {t("devices.ota.install")}
            </Button>
          </div>
        )}

        {!otaProgress &&
          updateChecked &&
          !hasUpdate &&
          !noVersion &&
          serverVersion && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <Check className="size-3" />
              {t("devices.ota.upToDate")}
            </div>
          )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={checkForUpdates}
            disabled={checking || otaProgress === "downloading" || otaProgress === "installing"}
          >
            {checking ? t("devices.ota.checking") : t("devices.ota.check")}
          </Button>
        </div>

        {/* Auto-Update Toggle */}
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <button
            type="button"
            role="switch"
            aria-checked={device?.auto_update || false}
            onClick={toggleAutoUpdate}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
              device?.auto_update ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                device?.auto_update ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-muted-foreground">
            {t("devices.ota.autoUpdate")}
          </span>
        </label>

        {/* Auto-restart toggle — like auto-update */}
        <label className="flex items-center gap-2 cursor-pointer text-sm">
          <button
            type="button"
            role="switch"
            aria-checked={scheduleEnabled}
            onClick={toggleSchedule}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${
              scheduleEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${
                scheduleEnabled ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
          <span className="text-muted-foreground">{t("devices.restart.title")}</span>
        </label>

        {scheduleEnabled && (
          <div className="space-y-3 pl-11">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map(({ key, labelKey }) => {
                const active = scheduleDays.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleScheduleDay(key)}
                    className={`h-8 w-9 rounded-lg border text-xs font-medium transition-colors ${
                      active
                        ? "border-primary/30 bg-primary/10 text-foreground"
                        : "border-border/70 bg-card text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">{t("devices.manage.time")}</Label>
              <Input
                type="time"
                value={scheduleTime}
                onChange={(e) => changeScheduleTime(e.target.value)}
                className="h-8 w-28 tabular-nums"
              />
            </div>
          </div>
        )}
      </div>

      {/* Wi-Fi is managed purely locally on the sensor (setup portal). Only the
          sensor-specific AP password is shown here — hidden for viewers. */}
      {!isViewer && (
      <div className="mt-4">
        <span className="text-sm text-muted-foreground">{t("devices.wifi.title")}</span>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("devices.wifi.description")}
        </p>

        {/* Setup AP password (sensor-specific, for re-setup) */}
        {setupPassword ? (
          <div className="mt-2 flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5 text-sm">
            <span className="flex items-center gap-2 min-w-0">
              <KeyRound className="size-3 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground shrink-0">{t("devices.wifi.passwordLabel")}</span>
              <span className="font-mono truncate select-all">{setupPassword}</span>
            </span>
            <button
              className="text-muted-foreground hover:text-foreground ml-2 shrink-0"
              onClick={() => setSetupPassword(null)}
              title={t("devices.wifi.hide")}
            >
              <X className="size-3" />
            </button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-6 px-1.5 text-xs text-muted-foreground"
            onClick={() => sendCommand("get-setup-password")}
            disabled={loading}
          >
            <KeyRound className="size-3 mr-1" />
            {t("devices.wifi.fetchPassword")}
          </Button>
        )}
      </div>
      )}

      {/* Status messages */}
      {commandStatus && (
        <p className="mt-3 text-sm text-green-600 dark:text-green-400">
          {commandStatus}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      {/* Action Buttons */}
      <div className="mt-4 flex flex-col gap-2 border-t pt-4">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirmAction("restart")}
          disabled={loading}
        >
          <RefreshCw className="size-3 mr-1.5" />
          {t("devices.action.restart")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setConfirmAction("reset_all")}
          disabled={loading}
        >
          <RotateCcw className="size-3 mr-1.5" />
          {t("devices.action.resetAll")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => {
            fetchSetupPassword();
            setConfirmAction("wifi_reset");
          }}
          disabled={loading}
        >
          <WifiOff className="size-3 mr-1.5" />
          {t("devices.action.wifiReset")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmAction("delete")}
          disabled={loading}
        >
          <Trash2 className="size-3 mr-1.5" />
          {t("devices.action.delete")}
        </Button>
      </div>

      {/* Confirm Dialog */}
      <Dialog
        open={!!confirmAction}
        onOpenChange={() => setConfirmAction(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === "restart" && t("devices.confirm.restart.title")}
              {confirmAction === "reset_all" && t("devices.confirm.resetAll.title")}
              {confirmAction === "wifi_reset" && t("devices.confirm.wifiReset.title")}
              {confirmAction === "delete" && t("devices.confirm.delete.title")}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === "restart" &&
                t("devices.confirm.restart.text")}
              {confirmAction === "reset_all" &&
                t("devices.confirm.resetAll.text")}
              {confirmAction === "wifi_reset" &&
                t("devices.confirm.wifiReset.text")}
              {confirmAction === "delete" &&
                t("devices.confirm.delete.text")}
            </DialogDescription>
          </DialogHeader>
          {/* Show the setup password BEFORE the Wi-Fi reset — afterwards the sensor
              is offline and the portal is unreachable without this password. */}
          {confirmAction === "wifi_reset" && (
            <div className="rounded-md bg-muted/50 px-3 py-2.5 text-sm flex items-center gap-2">
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground shrink-0">{t("devices.wifi.passwordLabel")}</span>
              {setupPassword ? (
                <span className="font-mono font-semibold select-all">{setupPassword}</span>
              ) : (
                <span className="text-muted-foreground italic">
                  {t("devices.wifi.useLabelCode")}
                </span>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>
              {t("devices.manage.cancel")}
            </Button>
            <Button
              variant={confirmAction === "restart" || confirmAction === "reset_all" ? "default" : "destructive"}
              onClick={() => {
                if (confirmAction === "restart") sendCommand("restart");
                else if (confirmAction === "reset_all") resetAllCommands();
                else if (confirmAction === "wifi_reset")
                  sendCommand("wifi-reset");
                else if (confirmAction === "delete") handleDelete();
              }}
              disabled={loading}
            >
              {loading
                ? t("devices.confirm.sending")
                : confirmAction === "restart"
                  ? t("devices.action.restart")
                  : confirmAction === "reset_all"
                    ? t("devices.confirm.reset")
                    : confirmAction === "wifi_reset"
                      ? t("devices.confirm.reset")
                      : t("devices.confirm.deleteForever")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
