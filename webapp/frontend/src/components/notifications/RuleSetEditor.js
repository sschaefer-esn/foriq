"use client";

import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import MachineMultiSelect from "@/components/notifications/MachineMultiSelect";
import { cn } from "@/lib/utils";
import { apiDetailMessage, useT } from "@/lib/i18n";

const DAYS = [
  { id: 1, labelKey: "notifications.day.1" },
  { id: 2, labelKey: "notifications.day.2" },
  { id: 3, labelKey: "notifications.day.3" },
  { id: 4, labelKey: "notifications.day.4" },
  { id: 5, labelKey: "notifications.day.5" },
  { id: 6, labelKey: "notifications.day.6" },
  { id: 7, labelKey: "notifications.day.7" },
];

const DEFAULT_WINDOW = {
  days: [1, 2, 3, 4, 5],
  start: "08:00",
  end: "18:00",
};

function emptyForm(preferredDeviceId, unavailableDeviceRules = {}) {
  return {
    name: "",
    enabled: true,
    threshold_minutes: 10,
    require_work_phase: false,
    minimum_work_minutes: 5,
    notify_activity_resumed: true,
    notify_device_offline: false,
    weekly_windows: [{ ...DEFAULT_WINDOW, days: [...DEFAULT_WINDOW.days] }],
    device_ids: preferredDeviceId && !unavailableDeviceRules[String(preferredDeviceId)]
      ? [preferredDeviceId]
      : [],
  };
}

function formFromRule(rule, preferredDeviceId, unavailableDeviceRules) {
  if (!rule) return emptyForm(preferredDeviceId, unavailableDeviceRules);
  const deviceIds = rule.device_ids?.length
    ? rule.device_ids
    : (rule.devices || []).map((device) => device.id);
  return {
    name: rule.name || "",
    enabled: Boolean(rule.enabled),
    threshold_minutes: rule.threshold_minutes ?? 10,
    require_work_phase: Boolean(rule.require_work_phase),
    minimum_work_minutes: rule.minimum_work_minutes ?? 5,
    notify_activity_resumed: rule.notify_activity_resumed !== false,
    notify_device_offline: Boolean(rule.notify_device_offline),
    weekly_windows: (rule.weekly_windows || []).map((window) => ({
      ...window,
      days: [...(window.days || [])],
    })),
    device_ids: [...deviceIds],
  };
}

function errorMessage(error, t) {
  return apiDetailMessage(error.response?.data?.detail) || t("notifications.editor.saveError");
}

function validate(form, t) {
  if (!form.name.trim()) return t("notifications.editor.nameRequired");
  const threshold = Number(form.threshold_minutes);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 1440) {
    return t("notifications.editor.thresholdRange");
  }
  const workMinutes = Number(form.minimum_work_minutes);
  if (form.require_work_phase && (
    !Number.isInteger(workMinutes) || workMinutes < 1 || workMinutes > 1440
  )) {
    return t("notifications.editor.workRange");
  }
  if (!form.device_ids.length) return t("notifications.editor.machineRequired");
  if (!form.weekly_windows.length) return t("notifications.editor.windowRequired");
  if (form.weekly_windows.some((window) => !window.days.length)) {
    return t("notifications.editor.windowDayRequired");
  }
  if (form.weekly_windows.some((window) => (
    !window.start || !window.end || window.start === window.end
  ))) {
    return t("notifications.editor.windowStartEnd");
  }
  return "";
}

export default function RuleSetEditor({
  open,
  onOpenChange,
  rule,
  devices,
  preferredDeviceId,
  unavailableDeviceRules,
  onSaved,
}) {
  const t = useT();
  const formId = useId();
  const [form, setForm] = useState(() => formFromRule(
    rule,
    preferredDeviceId,
    unavailableDeviceRules,
  ));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(formFromRule(rule, preferredDeviceId, unavailableDeviceRules));
    setError("");
  }, [open, preferredDeviceId, rule, unavailableDeviceRules]);

  function updateWindow(index, patch) {
    setForm((current) => ({
      ...current,
      weekly_windows: current.weekly_windows.map((window, position) =>
        position === index ? { ...window, ...patch } : window),
    }));
  }

  function toggleDay(index, dayId) {
    const window = form.weekly_windows[index];
    const active = window.days.includes(dayId);
    updateWindow(index, {
      days: active
        ? window.days.filter((id) => id !== dayId)
        : [...window.days, dayId].sort(),
    });
  }

  async function save(event) {
    event.preventDefault();
    const validationError = validate(form, t);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");
    const payload = {
      name: form.name.trim(),
      enabled: form.enabled,
      threshold_minutes: Number(form.threshold_minutes),
      require_work_phase: form.require_work_phase,
      minimum_work_minutes: Number(form.minimum_work_minutes),
      notify_activity_resumed: form.notify_activity_resumed,
      notify_device_offline: form.notify_device_offline,
      weekly_windows: form.weekly_windows,
      device_ids: form.device_ids,
    };

    try {
      const { data } = rule?.id
        ? await api.put(`/notifications/rule-sets/${rule.id}`, payload)
        : await api.post("/notifications/rule-sets", payload);
      onSaved?.(data);
      onOpenChange?.(false);
    } catch (requestError) {
      setError(errorMessage(requestError, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange?.(nextOpen);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? t("notifications.editor.editTitle") : t("notifications.editor.newTitle")}</DialogTitle>
          <DialogDescription>
            {t("notifications.editor.description")}
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={save} className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor={`${formId}-name`}>{t("notifications.editor.name")}</Label>
              <Input
                id={`${formId}-name`}
                value={form.name}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  name: event.target.value,
                }))}
                maxLength={255}
                placeholder={t("notifications.editor.namePlaceholder")}
                autoFocus
              />
            </div>
            <label className="flex h-9 items-center gap-2 rounded-md border border-border/70 px-3 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))}
                className="size-4 accent-primary"
              />
              {t("notifications.editor.active")}
            </label>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("notifications.editor.machines")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("notifications.editor.machinesHint")}
            </p>
            <MachineMultiSelect
              devices={devices}
              value={form.device_ids}
              unavailableDeviceRules={unavailableDeviceRules}
              onChange={(deviceIds) => setForm((current) => ({
                ...current,
                device_ids: deviceIds,
              }))}
            />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("notifications.editor.sequence")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("notifications.editor.sequenceHint")}
            </p>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className={cn(
                "cursor-pointer rounded-xl border p-3 transition-colors",
                !form.require_work_phase
                  ? "border-primary/40 bg-primary/5"
                  : "border-border/60 bg-muted/20 hover:bg-muted/35",
              )}>
                <span className="flex items-start gap-2.5">
                  <input
                    type="radio"
                    name={`${formId}-sequence`}
                    checked={!form.require_work_phase}
                    onChange={() => setForm((current) => ({
                      ...current,
                      require_work_phase: false,
                    }))}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium">{t("notifications.editor.pauseOnly")}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("notifications.editor.pauseOnlyHint")}
                    </span>
                  </span>
                </span>
              </label>
              <label className={cn(
                "cursor-pointer rounded-xl border p-3 transition-colors",
                form.require_work_phase
                  ? "border-primary/40 bg-primary/5"
                  : "border-border/60 bg-muted/20 hover:bg-muted/35",
              )}>
                <span className="flex items-start gap-2.5">
                  <input
                    type="radio"
                    name={`${formId}-sequence`}
                    checked={form.require_work_phase}
                    onChange={() => setForm((current) => ({
                      ...current,
                      require_work_phase: true,
                    }))}
                    className="mt-0.5 size-4 accent-primary"
                  />
                  <span>
                    <span className="block text-sm font-medium">{t("notifications.editor.workAndPause")}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {t("notifications.editor.workAndPauseHint")}
                    </span>
                  </span>
                </span>
              </label>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/25 p-3">
              <div className={cn(
                "grid items-center gap-2",
                form.require_work_phase
                  ? "sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto]"
                  : "sm:grid-cols-[minmax(0,1fr)_auto_auto]",
              )}>
                {form.require_work_phase && (
                  <>
                    <label className="rounded-lg bg-background p-3 shadow-sm">
                      <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t("notifications.editor.stepWork")}
                      </span>
                      <span className="mt-2 flex items-center gap-2 text-sm">
                        <Input
                          type="number"
                          min="1"
                          max="1440"
                          inputMode="numeric"
                          value={form.minimum_work_minutes}
                          onChange={(event) => setForm((current) => ({
                            ...current,
                            minimum_work_minutes: event.target.value,
                          }))}
                          className="w-20 tabular-nums"
                          aria-label={t("notifications.editor.workAria")}
                        />
                        <span className="text-muted-foreground">{t("notifications.editor.minActive")}</span>
                      </span>
                    </label>
                    <span className="hidden text-muted-foreground sm:block" aria-hidden="true">→</span>
                  </>
                )}
                <label className="rounded-lg bg-background p-3 shadow-sm">
                  <span className="block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {form.require_work_phase ? t("notifications.editor.stepPause2") : t("notifications.editor.stepPause1")}
                  </span>
                  <span className="mt-2 flex items-center gap-2 text-sm">
                    <Input
                      type="number"
                      min="1"
                      max="1440"
                      inputMode="numeric"
                      value={form.threshold_minutes}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        threshold_minutes: event.target.value,
                      }))}
                      className="w-20 tabular-nums"
                      aria-label={t("notifications.editor.pauseAria")}
                    />
                    <span className="text-muted-foreground">{t("notifications.editor.minWithoutStroke")}</span>
                  </span>
                </label>
                <span className="hidden text-muted-foreground sm:block" aria-hidden="true">→</span>
                <span className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-center text-xs font-medium text-primary">
                  {form.require_work_phase ? t("notifications.editor.stepAlert3") : t("notifications.editor.stepAlert2")}
                </span>
              </div>
              {form.require_work_phase && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("notifications.editor.workResetHint")}
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("notifications.editor.extra")}</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-muted/25 p-3">
              <input
                type="checkbox"
                checked={form.notify_activity_resumed}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  notify_activity_resumed: event.target.checked,
                }))}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium">{t("notifications.editor.notifyResumed")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("notifications.editor.notifyResumedHint")}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 bg-muted/25 p-3">
              <input
                type="checkbox"
                checked={form.notify_device_offline}
                onChange={(event) => setForm((current) => ({
                  ...current,
                  notify_device_offline: event.target.checked,
                }))}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="block text-sm font-medium">{t("notifications.editor.notifyOffline")}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t("notifications.editor.notifyOfflineHint")}
                </span>
              </span>
            </label>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t("notifications.editor.windows")}</legend>
            <p className="text-xs text-muted-foreground">
              {t("notifications.editor.windowsHint")}
            </p>

            <div className="space-y-3">
              {form.weekly_windows.map((window, index) => (
                <div
                  key={index}
                  className="rounded-xl border border-border/60 bg-muted/25 p-3"
                >
                  <div className="flex flex-wrap gap-1.5" aria-label={t("notifications.editor.windowDaysAria", { index: index + 1 })}>
                    {DAYS.map((day) => {
                      const active = window.days.includes(day.id);
                      return (
                        <button
                          key={day.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleDay(index, day.id)}
                          className={cn(
                            "min-w-8 rounded-md border px-2 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                            active
                              ? "border-foreground bg-foreground text-background"
                              : "border-border bg-background text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {t(day.labelKey)}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Input
                      type="time"
                      value={window.start}
                      onChange={(event) => updateWindow(index, { start: event.target.value })}
                      aria-label={t("notifications.editor.windowStartAria", { index: index + 1 })}
                      className="w-32 tabular-nums"
                    />
                    <span className="text-sm text-muted-foreground">{t("notifications.editor.until")}</span>
                    <Input
                      type="time"
                      value={window.end}
                      onChange={(event) => updateWindow(index, { end: event.target.value })}
                      aria-label={t("notifications.editor.windowEndAria", { index: index + 1 })}
                      className="w-32 tabular-nums"
                    />
                    {form.weekly_windows.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setForm((current) => ({
                          ...current,
                          weekly_windows: current.weekly_windows.filter((_, position) => position !== index),
                        }))}
                        aria-label={t("notifications.editor.windowRemoveAria", { index: index + 1 })}
                        className="ml-auto text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {form.weekly_windows.length < 12 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setForm((current) => ({
                  ...current,
                  weekly_windows: [
                    ...current.weekly_windows,
                    { ...DEFAULT_WINDOW, days: [...DEFAULT_WINDOW.days] },
                  ],
                }))}
              >
                <Plus className="size-4" />
                {t("notifications.editor.addWindow")}
              </Button>
            )}
          </fieldset>

          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange?.(false)}
            disabled={saving}
          >
            {t("notifications.cancel")}
          </Button>
          <Button type="submit" form={formId} disabled={saving}>
            {saving ? t("notifications.saving") : rule ? t("notifications.editor.saveChanges") : t("notifications.editor.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
