"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  BellOff,
  Check,
  CheckCircle2,
  CircleStop,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/ui/EmptyState";
import useNow from "@/hooks/useNow";
import useDeviceHref from "@/hooks/useDeviceHref";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/lib/i18n";
import { notificationMessage } from "@/lib/notificationMessage";

const TYPE_LABEL_KEYS = {
  no_hits: "notifications.type.no_hits",
  device_offline: "notifications.type.device_offline",
};

function typeLabel(t, type) {
  return TYPE_LABEL_KEYS[type] ? t(TYPE_LABEL_KEYS[type]) : null;
}

function formatTimestamp(value, t, intlLocale) {
  if (!value) return "–";
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = date.toLocaleTimeString(intlLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return t("notifications.time.today", { time });
  if (isYesterday) return t("notifications.time.yesterday", { time });
  return date.toLocaleString(intlLocale, {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(from, to, t) {
  if (!from) return "";
  const milliseconds = Math.max(0, to - new Date(from).getTime());
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 1) return t("notifications.duration.underMinute");
  if (minutes < 60) return t("notifications.duration.minutes", { minutes });
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (!remaining) return t("notifications.duration.hours", { hours });
  return t("notifications.duration.hoursMinutes", { hours, minutes: remaining });
}

function alertVisual(alert) {
  if (!alert.unread && !alert.resolved_at) {
    return {
      icon: CheckCircle2,
      dot: "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      line: "bg-border",
    };
  }
  if (alert.resolved_at) {
    return {
      icon: CheckCircle2,
      dot: "border-muted-foreground/35 bg-background text-muted-foreground",
      line: "bg-border",
    };
  }
  if (alert.alert_type === "device_offline") {
    return {
      icon: WifiOff,
      dot: "border-destructive/50 bg-destructive text-white ring-4 ring-destructive/10",
      line: "bg-destructive/25",
    };
  }
  return {
    icon: CircleStop,
    dot: "border-amber-500/60 bg-amber-500 text-white ring-4 ring-amber-500/10",
    line: "bg-amber-500/25",
  };
}

function NotificationRow({
  alert,
  isLast,
  highlighted,
  now,
  pending,
  onMarkRead,
  setRef,
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const deviceHref = useDeviceHref();
  const visual = alertVisual(alert);
  const Icon = visual.icon;
  const unresolved = !alert.resolved_at;
  const acknowledged = unresolved && !alert.unread;
  const needsAttention = unresolved && alert.unread;
  const end = alert.resolved_at ? new Date(alert.resolved_at).getTime() : now;

  return (
    <li ref={setRef} className="grid scroll-mt-6 grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div className="relative flex justify-center pt-4" aria-hidden="true">
        {!isLast && (
          <span className={cn("absolute bottom-[-1.5rem] top-9 w-px", visual.line)} />
        )}
        <span className={cn("relative z-10 grid size-6 place-items-center rounded-full border", visual.dot)}>
          <Icon className="size-3" strokeWidth={2} />
        </span>
      </div>

      <article
        aria-label={t("notifications.row.aria", {
          type: typeLabel(t, alert.alert_type) || t("notifications.row.fallbackType"),
          machine: alert.device_name || t("notifications.row.fallbackMachine"),
        })}
        className={cn(
          "rounded-2xl border border-border/60 bg-card p-4 shadow-card transition-[box-shadow,background-color] sm:p-5",
          alert.unread && "border-primary/20 bg-primary/[0.025]",
          highlighted && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        )}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                needsAttention
                  ? alert.alert_type === "device_offline"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                  : acknowledged
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground",
              )}>
                {needsAttention
                  ? t("notifications.status.active")
                  : acknowledged ? t("notifications.status.acknowledged") : t("notifications.status.resolved")}
              </span>
              <span className="text-xs font-medium text-muted-foreground">
                {typeLabel(t, alert.alert_type) || alert.alert_type}
              </span>
              {alert.unread && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                  {t("notifications.row.new")}
                </span>
              )}
            </div>
            <h3 className="mt-2 truncate text-base font-medium">
              {alert.device_name || t("notifications.unnamedMachine")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{notificationMessage(alert, t)}</p>
          </div>

          <div className="shrink-0 text-left sm:text-right">
            <p className="text-xs font-medium tabular-nums">{formatTimestamp(alert.triggered_at, t, intlLocale)}</p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {unresolved ? t("notifications.row.since") : t("notifications.row.duration")} {formatDuration(alert.condition_since_at, end, t)}
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          {alert.device_id && (
            <Button asChild variant="ghost" size="sm" className="-ml-2">
              <Link href={deviceHref(alert.device_id)}>
                {t("notifications.row.openMachine")}
                <ArrowUpRight className="size-3.5" />
              </Link>
            </Button>
          )}
          {alert.unread && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onMarkRead}
              disabled={pending}
              className="ml-auto text-muted-foreground"
            >
              <Check className="size-3.5" />
              {pending ? t("notifications.saving") : t("notifications.row.markRead")}
            </Button>
          )}
        </div>
      </article>
    </li>
  );
}

export default function NotificationTimeline({
  alerts,
  fleetDevices,
  markRead,
  markAllRead,
  loading = false,
  focusedIncidentId = "",
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const now = useNow(30000);
  const rowRefs = useRef(new Map());
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [pendingId, setPendingId] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const [actionError, setActionError] = useState("");

  const unnamed = t("notifications.unnamedMachine");
  const machines = useMemo(() => {
    const byId = new Map();
    (fleetDevices || []).forEach((device) => byId.set(String(device.id), {
      id: String(device.id),
      name: device.name || unnamed,
    }));
    (alerts || []).forEach((alert) => {
      if (!alert.device_id) return;
      const id = String(alert.device_id);
      if (!byId.has(id)) byId.set(id, {
        id,
        name: alert.device_name || unnamed,
      });
    });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, intlLocale));
  }, [alerts, fleetDevices, intlLocale, unnamed]);

  const attentionCount = (alerts || []).filter((alert) => (
    !alert.resolved_at && alert.unread
  )).length;
  const acknowledgedCount = (alerts || []).filter((alert) => (
    !alert.resolved_at && !alert.unread
  )).length;
  const unreadCount = (alerts || []).filter((alert) => alert.unread).length;
  const filteredAlerts = useMemo(() => (alerts || [])
    .filter((alert) => {
      if (statusFilter === "active" && (alert.resolved_at || !alert.unread)) return false;
      if (statusFilter === "acknowledged" && (alert.resolved_at || alert.unread)) return false;
      if (statusFilter === "resolved" && !alert.resolved_at) return false;
      if (statusFilter === "unread" && !alert.unread) return false;
      if (typeFilter !== "all" && alert.alert_type !== typeFilter) return false;
      if (deviceFilter !== "all" && String(alert.device_id) !== deviceFilter) return false;
      return true;
    })
    .sort((a, b) => {
      const rank = (alert) => {
        if (!alert.resolved_at && alert.unread) return 0;
        if (alert.resolved_at && alert.unread) return 1;
        if (!alert.resolved_at) return 2;
        return 3;
      };
      const rankDifference = rank(a) - rank(b);
      if (rankDifference) return rankDifference;
      return new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime();
    }), [alerts, deviceFilter, statusFilter, typeFilter]);

  useEffect(() => {
    if (!focusedIncidentId) return;
    const exists = (alerts || []).some((alert) => String(alert.id) === String(focusedIncidentId));
    if (!exists) return;
    setStatusFilter("all");
    setTypeFilter("all");
    setDeviceFilter("all");
    const timer = setTimeout(() => {
      rowRefs.current.get(String(focusedIncidentId))?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [alerts, focusedIncidentId]);

  async function handleMarkRead(alertId) {
    setPendingId(String(alertId));
    setActionError("");
    try {
      await markRead?.(alertId);
    } catch {
      setActionError(t("notifications.timeline.markReadError"));
    } finally {
      setPendingId("");
    }
  }

  async function handleMarkAllRead() {
    setMarkingAll(true);
    setActionError("");
    try {
      await markAllRead?.();
    } catch {
      setActionError(t("notifications.timeline.markAllReadError"));
    } finally {
      setMarkingAll(false);
    }
  }

  if (loading) {
    return (
      <section aria-label={t("notifications.timeline.loadingAria")}>
        <div className="h-28 animate-pulse rounded-2xl bg-muted/45" />
        <div className="mt-6 h-24 animate-pulse rounded-xl bg-muted/35" />
        <div className="mt-6 space-y-4">
          {[0, 1].map((item) => (
            <div key={item} className="ml-10 h-44 animate-pulse rounded-2xl bg-muted/40" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="timeline-heading">
      <div className={cn(
        "flex flex-col gap-4 rounded-2xl border p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5",
        attentionCount > 0
          ? "border-amber-500/25 bg-amber-500/[0.055]"
          : "border-emerald-500/20 bg-emerald-500/[0.045]",
      )}>
        <div className="flex items-center gap-3">
          <span className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl",
            attentionCount > 0
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
              : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          )}>
            {attentionCount > 0
              ? <CircleStop className="size-5" strokeWidth={1.75} />
              : <CheckCircle2 className="size-5" strokeWidth={1.75} />}
          </span>
          <div aria-live="polite">
            <h2 id="timeline-heading" className="font-medium">
              {attentionCount > 0
                ? t("notifications.timeline.activeHeading", { count: attentionCount })
                : acknowledgedCount > 0
                  ? t("notifications.timeline.allAcknowledged")
                  : t("notifications.timeline.noneActive")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {attentionCount > 0
                ? t("notifications.timeline.needsAttention")
                : acknowledgedCount > 0
                  ? t("notifications.timeline.acknowledgedInHistory", { count: acknowledgedCount })
                  : t("notifications.timeline.nothingNeedsAttention")}
            </p>
          </div>
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleMarkAllRead}
            disabled={markingAll}
            className="bg-background/70"
          >
            <Check className="size-4" />
            {markingAll ? t("notifications.saving") : t("notifications.timeline.markAllRead", { count: unreadCount })}
          </Button>
        )}
      </div>

      <div className="mt-6 grid gap-3 rounded-xl border border-border/60 bg-card p-3 sm:grid-cols-3 sm:p-4">
        <label className="space-y-1.5">
          <span className="text-label">{t("notifications.filter.status")}</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">{t("notifications.filter.allNotifications")}</option>
            <option value="active">{t("notifications.status.active")}</option>
            <option value="acknowledged">{t("notifications.status.acknowledged")}</option>
            <option value="resolved">{t("notifications.status.resolved")}</option>
            <option value="unread">{t("notifications.status.unread")}</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-label">{t("notifications.filter.type")}</span>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">{t("notifications.filter.allTypes")}</option>
            <option value="no_hits">{t("notifications.type.no_hits")}</option>
            <option value="device_offline">{t("notifications.type.device_offline")}</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-label">{t("notifications.filter.machine")}</span>
          <select
            value={deviceFilter}
            onChange={(event) => setDeviceFilter(event.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="all">{t("notifications.filter.allMachines")}</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>{machine.name}</option>
            ))}
          </select>
        </label>
      </div>

      {actionError && (
        <p role="alert" className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {filteredAlerts.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={(alerts || []).length === 0 ? CheckCircle2 : BellOff}
          title={(alerts || []).length === 0 ? t("notifications.timeline.emptyTitle") : t("notifications.timeline.noMatchTitle")}
          subtitle={(alerts || []).length === 0
            ? t("notifications.timeline.emptySubtitle")
            : t("notifications.timeline.noMatchSubtitle")}
        />
      ) : (
        <ol className="mt-6 space-y-6" aria-label={t("notifications.timeline.historyAria")}>
          {filteredAlerts.map((alert, index) => (
            <NotificationRow
              key={alert.id}
              alert={alert}
              isLast={index === filteredAlerts.length - 1}
              highlighted={String(alert.id) === String(focusedIncidentId)}
              now={now}
              pending={pendingId === String(alert.id)}
              onMarkRead={() => handleMarkRead(alert.id)}
              setRef={(node) => {
                const id = String(alert.id);
                if (node) rowRefs.current.set(id, node);
                else rowRefs.current.delete(id);
              }}
            />
          ))}
        </ol>
      )}
    </section>
  );
}
