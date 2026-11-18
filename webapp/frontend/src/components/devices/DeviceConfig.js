"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import api, { apiErrorMessage } from "@/lib/api";
import { useLocale, useT } from "@/lib/i18n";
import CountingFineTune from "@/components/devices/CountingFineTune";
import NotificationRuleSettings from "@/components/devices/NotificationRuleSettings";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function DeviceConfig({ device, onConfigChanged, onSettingSaved, onSettingError }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const fleet = useFleetLive();
  const [name, setName] = useState(device?.name || "");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [selectedTargets, setSelectedTargets] = useState([]);
  const [copyingSettings, setCopyingSettings] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [copyResult, setCopyResult] = useState("");
  const currentDeviceId = device?.id;
  const otherDevices = useMemo(() => fleet.devices
    .filter((entry) => String(entry.id) !== String(currentDeviceId))
    .sort((a, b) => (a.name || "").localeCompare(b.name || "", intlLocale)), [currentDeviceId, fleet.devices, intlLocale]);
  useEffect(() => setName(device?.name || ""), [device?.name]);
  useEffect(() => {
    setSelectedTargets([]);
    setCopyResult("");
  }, [device?.id]);

  async function saveName() {
    setSaving(true);
    try {
      const { data } = await api.put(`/devices/${device.id}`, { name: name.trim() });
      onConfigChanged?.(data);
    } finally {
      setSaving(false);
    }
  }

  async function saveCounting(patch) {
    try {
      const { data } = await api.put(`/devices/${device.id}`, patch);
      onConfigChanged?.(data);
      Object.entries(patch).forEach(([field, value]) => onSettingSaved?.(field, value));
      return data;
    } catch (error) {
      onSettingError?.(
        Object.keys(patch),
        apiErrorMessage(error, t("deviceDetail.config.error.saveParameters")),
      );
      throw error;
    }
  }

  function toggleTarget(deviceId) {
    setSelectedTargets((current) => current.includes(deviceId)
      ? current.filter((id) => id !== deviceId)
      : [...current, deviceId]);
  }

  async function copyCountingSettings() {
    if (!selectedTargets.length || copyingSettings) return;
    setCopyingSettings(true);
    setCopyError("");
    try {
      const { data } = await api.post("/devices/counting-settings/copy", {
        source_device_id: device.id,
        target_device_ids: selectedTargets,
      });
      await fleet.refresh();
      setCopyResult(t("deviceDetail.config.copyResult", { count: data.target_count }));
      setCopyOpen(false);
      setSelectedTargets([]);
    } catch (error) {
      setCopyError(apiErrorMessage(error, t("deviceDetail.config.error.copy")));
    } finally {
      setCopyingSettings(false);
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="text-label">{t("deviceDetail.config.machine")}</div>
        <label className="block space-y-2 text-sm font-medium">{t("deviceDetail.config.name")}<Input value={name} onChange={(event) => setName(event.target.value)} /></label>
        {name.trim() !== (device?.name || "") && <Button onClick={saveName} disabled={saving || !name.trim()}>{saving ? t("deviceDetail.saving") : t("deviceDetail.config.saveName")}</Button>}
        <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
          <span className="text-muted-foreground">{t("deviceDetail.config.serialNumber")}</span>
          <button className="inline-flex items-center gap-2 font-mono text-xs" onClick={async () => { await navigator.clipboard.writeText(device?.serial_number || ""); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {device?.serial_number || "–"}{copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          </button>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card p-4 shadow-card">
        <h3 className="text-sm font-medium">{t("deviceDetail.config.fineTuneTitle")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("deviceDetail.config.fineTuneSubtitle")}</p>
        <CountingFineTune value={device} onSave={saveCounting} />
        {otherDevices.length > 0 && (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">{t("deviceDetail.config.copyTitle")}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t("deviceDetail.config.copyHint")}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => { setCopyError(""); setCopyOpen(true); }}>
              <Copy className="size-4" />{t("deviceDetail.config.copyButton")}
            </Button>
          </div>
        )}
        {copyResult && <p className="mt-3 text-xs font-medium text-emerald-600 dark:text-emerald-400">{copyResult}</p>}
      </section>

      <NotificationRuleSettings deviceId={device.id} />

      <Dialog open={copyOpen} onOpenChange={(open) => { if (!copyingSettings) setCopyOpen(open); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("deviceDetail.config.copyDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("deviceDetail.config.copyDialog.description", { name: device?.name })}
            </DialogDescription>
          </DialogHeader>

          <div className="overflow-hidden rounded-xl border border-border/60">
            <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-4 py-3">
              <span className="text-xs font-medium text-muted-foreground">{t("deviceDetail.config.copyDialog.targets")}</span>
              <button
                type="button"
                onClick={() => setSelectedTargets(selectedTargets.length === otherDevices.length ? [] : otherDevices.map((entry) => entry.id))}
                className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {selectedTargets.length === otherDevices.length ? t("deviceDetail.config.copyDialog.deselectAll") : t("deviceDetail.config.copyDialog.selectAll")}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto p-2">
              {otherDevices.map((entry) => {
                const selected = selectedTargets.includes(entry.id);
                return (
                  <label key={entry.id} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${selected ? "bg-primary/10" : "hover:bg-muted/50"}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleTarget(entry.id)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{entry.name || t("deviceDetail.config.unnamedMachine")}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {copyError && <p className="text-sm text-destructive">{copyError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCopyOpen(false)} disabled={copyingSettings}>{t("deviceDetail.cancel")}</Button>
            <Button type="button" onClick={copyCountingSettings} disabled={!selectedTargets.length || copyingSettings}>
              {copyingSettings ? t("deviceDetail.config.copyDialog.copying") : t("deviceDetail.config.copyDialog.submit", { count: selectedTargets.length || 0 })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
