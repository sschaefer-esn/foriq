"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Bell, BellRing, SlidersHorizontal } from "lucide-react";
import { useNotifications } from "@/components/providers/NotificationProvider";
import { useFleetLive } from "@/components/providers/FleetLiveProvider";
import NotificationTimeline from "@/components/notifications/NotificationTimeline";
import RuleSetsPanel from "@/components/notifications/RuleSetsPanel";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const TABS = [
  { id: "events", labelKey: "notifications.tab.events", icon: Bell },
  { id: "rules", labelKey: "notifications.tab.rules", icon: SlidersHorizontal },
];

export function NotificationCenterSkeleton() {
  const t = useT();
  return (
    <div className="mx-auto w-full max-w-6xl pb-12 pt-2 md:pt-6" aria-label={t("notifications.center.loadingAria")}>
      <div className="h-8 w-52 animate-pulse rounded-lg bg-muted/50" />
      <div className="mt-3 h-4 w-full max-w-xl animate-pulse rounded bg-muted/40" />
      <div className="mt-8 h-11 animate-pulse rounded-lg bg-muted/35" />
      <div className="mt-6 h-36 animate-pulse rounded-2xl bg-muted/40" />
    </div>
  );
}

function normalizedTab(value) {
  return TABS.some((tab) => tab.id === value) ? value : "events";
}

export default function NotificationCenter() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const notifications = useNotifications();
  const fleet = useFleetLive();
  const requestedTab = searchParams.get("incident")
    ? "events"
    : normalizedTab(searchParams.get("tab"));
  const [activeTab, setActiveTab] = useState(requestedTab);

  useEffect(() => {
    setActiveTab(requestedTab);
  }, [requestedTab]);

  const alerts = notifications?.alerts || [];
  const loading = notifications?.loading ?? true;
  const activeCount = alerts.filter((alert) => !alert.resolved_at && alert.unread).length;
  const acknowledgedCount = alerts.filter((alert) => !alert.resolved_at && !alert.unread).length;
  const unreadCount = notifications?.unreadCount || 0;

  function selectTab(tabId) {
    setActiveTab(tabId);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tabId);
    if (tabId !== "rules") params.delete("device");
    if (tabId !== "events") params.delete("incident");
    const query = params.toString();
    router.replace(query ? `/notifications?${query}` : "/notifications", { scroll: false });
  }

  function handleTabKey(event, index) {
    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = TABS[nextIndex];
    selectTab(nextTab.id);
    requestAnimationFrame(() => {
      document.getElementById(`notification-tab-${nextTab.id}`)?.focus();
    });
  }

  return (
    <div className="mx-auto w-full max-w-6xl pb-12 pt-2 md:pt-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-label">
            <BellRing className="size-3.5 text-primary" strokeWidth={1.75} />
            {t("notifications.center.eyebrow")}
          </div>
          <h1 className="mt-2 text-[24px] font-semibold tracking-tight">{t("notifications.center.title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t("notifications.center.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <span className={cn(
            "size-2 rounded-full",
            loading ? "animate-pulse bg-muted-foreground/40" : activeCount > 0 ? "bg-amber-500" : "bg-emerald-500",
          )} />
          {loading
            ? t("notifications.center.loading")
            : activeCount > 0
            ? `${t("notifications.center.activeCount", { count: activeCount })}${unreadCount ? t("notifications.center.unreadSuffix", { count: unreadCount }) : ""}`
            : acknowledgedCount > 0
              ? t("notifications.center.acknowledgedCount", { count: acknowledgedCount })
            : unreadCount > 0
              ? t("notifications.center.unreadCount", { count: unreadCount })
              : t("notifications.center.noneOpen")}
        </div>
      </header>

      <nav className="mt-7 overflow-x-auto border-b border-border/60 no-scrollbar" aria-label={t("notifications.center.tabsAria")}>
        <div role="tablist" className="flex min-w-max gap-1">
          {TABS.map((tab, index) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`notification-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`notification-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => handleTabKey(event, index)}
                className={cn(
                  "relative flex items-center gap-2 px-3 py-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  selected
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", selected && "text-primary")} strokeWidth={1.75} />
                {t(tab.labelKey)}
                {tab.id === "events" && unreadCount > 0 && (
                  <span className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-primary-foreground">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
                {selected && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="pt-6">
        {activeTab === "events" && (
          <div
            id="notification-panel-events"
            role="tabpanel"
            aria-labelledby="notification-tab-events"
          >
            <NotificationTimeline
              alerts={alerts}
              fleetDevices={fleet.devices}
              markRead={notifications?.markRead}
              markAllRead={notifications?.markAllRead}
              loading={loading}
              focusedIncidentId={searchParams.get("incident") || ""}
            />
          </div>
        )}
        {activeTab === "rules" && (
          <div
            id="notification-panel-rules"
            role="tabpanel"
            aria-labelledby="notification-tab-rules"
          >
            <RuleSetsPanel focusedDeviceId={searchParams.get("device") || ""} />
          </div>
        )}
      </div>
    </div>
  );
}
