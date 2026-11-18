"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  BellRing,
  CalendarClock,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import api, { apiErrorMessage } from "@/lib/api";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/ui/EmptyState";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import RuleSetEditor from "@/components/notifications/RuleSetEditor";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/lib/i18n";

const DAY_KEYS = {
  1: "notifications.day.1",
  2: "notifications.day.2",
  3: "notifications.day.3",
  4: "notifications.day.4",
  5: "notifications.day.5",
  6: "notifications.day.6",
  7: "notifications.day.7",
};

function deviceIds(rule) {
  if (rule.device_ids?.length) return rule.device_ids.map(String);
  return (rule.devices || []).map((device) => String(device.id));
}

function windowLabel(window, t) {
  const days = [...(window.days || [])].sort();
  let dayText = days.map((day) => (DAY_KEYS[day] ? t(DAY_KEYS[day]) : null)).filter(Boolean).join(", ");
  if (days.join(",") === "1,2,3,4,5") dayText = t("notifications.days.weekdays");
  if (days.join(",") === "1,2,3,4,5,6,7") dayText = t("notifications.days.daily");
  return `${dayText || t("notifications.days.none")} · ${window.start}–${window.end}`;
}

function RuleCard({ rule, canEdit, focused, onEdit, onDelete }) {
  const t = useT();
  const devices = rule.devices || [];
  const windows = rule.weekly_windows || [];

  return (
    <article
      className={cn(
        "rounded-2xl border border-border/60 bg-card p-4 shadow-card transition-shadow sm:p-5",
        focused && "ring-2 ring-primary/35 ring-offset-2 ring-offset-background",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl",
            rule.enabled
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <BellRing className="size-[18px]" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-medium">{rule.name}</h3>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                rule.enabled
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {rule.enabled ? t("notifications.rule.active") : t("notifications.rule.paused")}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {rule.require_work_phase ? (
              <>
                <span className="font-medium text-foreground tabular-nums">{t("notifications.rule.minutes", { minutes: rule.minimum_work_minutes })}</span> {t("notifications.rule.work")}
                <span className="px-1.5" aria-hidden="true">→</span>
                <span className="font-medium text-foreground tabular-nums">{t("notifications.rule.minutes", { minutes: rule.threshold_minutes })}</span> {t("notifications.rule.pause")}
                <span className="px-1.5" aria-hidden="true">→</span>
                {t("notifications.rule.alert")}
              </>
            ) : (
              <>
                {t("notifications.rule.alertAfter")} <span className="font-medium text-foreground tabular-nums">{t("notifications.rule.minutes", { minutes: rule.threshold_minutes })}</span> {t("notifications.rule.withoutStroke")}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("notifications.rule.activityResumed")} {rule.notify_activity_resumed === false ? t("notifications.rule.dontNotify") : t("notifications.rule.notify")}
            <span className="px-1.5" aria-hidden="true">·</span>
            {t("notifications.rule.sensorOutages")} {rule.notify_device_offline ? t("notifications.rule.notify") : t("notifications.rule.dontNotify")}
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onEdit}
              aria-label={t("notifications.rule.editAria", { name: rule.name })}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onDelete}
              aria-label={t("notifications.rule.deleteAria", { name: rule.name })}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 border-t border-border/60 pt-4 lg:grid-cols-2">
        <div>
          <div className="text-label">{t("notifications.rule.machines")}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {devices.slice(0, 4).map((device) => (
              <span
                key={device.id}
                className="max-w-full truncate rounded-md bg-muted/60 px-2 py-1 text-xs font-medium"
              >
                {device.name || t("notifications.unnamedMachine")}
              </span>
            ))}
            {devices.length > 4 && (
              <span className="rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                +{devices.length - 4}
              </span>
            )}
            {devices.length === 0 && (
              <span className="text-xs text-muted-foreground">{t("notifications.rule.noMachines")}</span>
            )}
          </div>
        </div>

        <div>
          <div className="text-label">{t("notifications.rule.windows")}</div>
          <div className="mt-2 space-y-1.5">
            {windows.slice(0, 2).map((window, index) => (
              <div key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
                <CalendarClock className="size-3.5 shrink-0" strokeWidth={1.75} />
                <span className="tabular-nums">{windowLabel(window, t)}</span>
              </div>
            ))}
            {windows.length > 2 && (
              <p className="pl-[22px] text-xs text-muted-foreground">
                {t("notifications.rule.moreWindows", { count: windows.length - 2 })}
              </p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function RuleSetsPanel({ focusedDeviceId = "" }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const { data: session } = useAuth();
  const fleet = useFleetLive();
  const canEdit = ["owner", "admin"].includes(session?.user?.role);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const loadRules = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { data } = await api.get("/notifications/rule-sets");
      setRules(Array.isArray(data) ? data : data?.items || []);
    } catch (error) {
      setLoadError(apiErrorMessage(error, t("notifications.rules.loadError")));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  const focusedMachine = useMemo(
    () => fleet.devices.find((device) => String(device.id) === String(focusedDeviceId)),
    [fleet.devices, focusedDeviceId],
  );
  const sortedRules = useMemo(() => [...rules].sort((a, b) => {
    if (focusedDeviceId) {
      const aFocused = deviceIds(a).includes(String(focusedDeviceId));
      const bFocused = deviceIds(b).includes(String(focusedDeviceId));
      if (aFocused !== bFocused) return aFocused ? -1 : 1;
    }
    if (Boolean(a.enabled) !== Boolean(b.enabled)) return a.enabled ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "", intlLocale);
  }), [focusedDeviceId, intlLocale, rules]);
  const editingRuleId = editingRule?.id;
  const unavailableDeviceRules = useMemo(() => {
    const assigned = {};
    rules.forEach((rule) => {
      if (editingRuleId && rule.id === editingRuleId) return;
      deviceIds(rule).forEach((deviceId) => {
        assigned[deviceId] = rule.name;
      });
    });
    return assigned;
  }, [editingRuleId, rules]);

  function openCreate() {
    setEditingRule(null);
    setEditorOpen(true);
  }

  function openEdit(rule) {
    setEditingRule(rule);
    setEditorOpen(true);
  }

  async function deleteRule() {
    if (!deleteCandidate || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.delete(`/notifications/rule-sets/${deleteCandidate.id}`);
      setRules((current) => current.filter((rule) => rule.id !== deleteCandidate.id));
      setDeleteCandidate(null);
    } catch (error) {
      setDeleteError(apiErrorMessage(error, t("notifications.rules.deleteError")));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section aria-labelledby="rules-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-label">{t("notifications.rules.eyebrow")}</div>
          <h2 id="rules-heading" className="mt-1 text-lg font-semibold">{t("notifications.rules.title")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t("notifications.rules.subtitle")}
          </p>
        </div>
        {canEdit && (
          <Button onClick={openCreate} disabled={fleet.loading || fleet.devices.length === 0}>
            <Plus className="size-4" />
            {t("notifications.rules.new")}
          </Button>
        )}
      </div>

      {focusedDeviceId && (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 text-sm">
          <ChevronRight className="size-4 shrink-0 text-primary" />
          <span>
            {t("notifications.rules.focusedPrefix")} <strong>{focusedMachine?.name || t("notifications.rules.thisMachine")}</strong> {t("notifications.rules.focusedSuffix")}
          </span>
        </div>
      )}

      {!canEdit && (
        <p className="mt-5 rounded-xl border border-border/60 bg-muted/25 px-4 py-3 text-sm text-muted-foreground">
          {t("notifications.rules.viewerHint")}
        </p>
      )}

      {loadError ? (
        <div className="mt-6 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
          <p role="alert" className="text-sm text-destructive">{loadError}</p>
          <Button variant="outline" size="sm" onClick={loadRules} className="mt-3">
            <RefreshCw className="size-4" />
            {t("notifications.rules.reload")}
          </Button>
        </div>
      ) : loading ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2" aria-label={t("notifications.rules.loadingAria")}>
          {[0, 1].map((item) => (
            <div key={item} className="h-52 animate-pulse rounded-2xl bg-muted/45" />
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={BellRing}
          title={t("notifications.rules.emptyTitle")}
          subtitle={canEdit
            ? t("notifications.rules.emptySubtitleEditor")
            : t("notifications.rules.emptySubtitleViewer")}
          action={canEdit ? <Button onClick={openCreate}>{t("notifications.rules.createFirst")}</Button> : null}
        />
      ) : (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          {sortedRules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              canEdit={canEdit}
              focused={Boolean(focusedDeviceId && deviceIds(rule).includes(String(focusedDeviceId)))}
              onEdit={() => openEdit(rule)}
              onDelete={() => {
                setDeleteError("");
                setDeleteCandidate(rule);
              }}
            />
          ))}
        </div>
      )}

      {canEdit && (
        <RuleSetEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          rule={editingRule}
          devices={fleet.devices}
          preferredDeviceId={unavailableDeviceRules[String(focusedDeviceId)] ? "" : focusedDeviceId}
          unavailableDeviceRules={unavailableDeviceRules}
          onSaved={loadRules}
        />
      )}

      <Dialog
        open={Boolean(deleteCandidate)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteCandidate(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("notifications.rules.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("notifications.rules.deleteDescription", { name: deleteCandidate?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteCandidate(null)} disabled={deleting}>
              {t("notifications.cancel")}
            </Button>
            <Button variant="destructive" onClick={deleteRule} disabled={deleting}>
              {deleting ? t("notifications.rules.deleting") : t("notifications.rules.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
