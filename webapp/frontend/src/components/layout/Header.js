"use client";

import Link from "next/link";
import { useAuth, signOut } from "@/lib/auth";
import ForiqLogo from "@/components/ui/ForiqLogo";
import {
  ChevronDown,
  LogOut,
  Bell,
  Sun,
  Moon,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import MobileMenu from "@/components/layout/MobileMenu";
import { useNotifications } from "@/components/providers/NotificationProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useLocale, useT } from "@/lib/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { notificationMessage } from "@/lib/notificationMessage";

const SEVERITY_DOT = {
  critical: "bg-destructive",
  warning: "bg-amber-500",
};

const TYPE_LABEL_KEYS = {
  no_hits: "layout.alertType.noHits",
  device_offline: "layout.alertType.deviceOffline",
};

function formatTime(isoStr, intlLocale) {
  const d = new Date(isoStr);
  return d.toLocaleString(intlLocale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Header() {
  const { data: session } = useAuth();
  const notifications = useNotifications();
  const unreadAlerts = (notifications?.alerts || []).filter((alert) => alert.unread);
  const { theme, setTheme } = useTheme();
  const t = useT();
  const { intlLocale } = useLocale();
  const [showCenter, setShowCenter] = useState(false);
  const centerRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (centerRef.current && !centerRef.current.contains(e.target)) {
        setShowCenter(false);
      }
    }
    if (showCenter) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showCenter]);

  const initials = (session?.user?.name || "?")
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="relative z-20 flex h-16 items-center bg-background px-4 md:px-6">
      <div className="flex items-center gap-2 md:hidden">
        <MobileMenu />
        <Link href="/dashboard" aria-label="Foriq">
          <ForiqLogo className="h-7 w-auto text-foreground" />
        </Link>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5 md:gap-3">
        {session?.user && (
          <>
            <div className="relative" ref={centerRef}>
              <button
                onClick={() => setShowCenter((prev) => !prev)}
                className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label={t("layout.notifications.title")}
                aria-expanded={showCenter}
              >
                <Bell className="size-[18px]" strokeWidth={1.75} />
                {notifications?.unreadCount > 0 && (
                  <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-destructive" />
                )}
              </button>

              {showCenter && (
                <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-lg">
                  <div className="flex items-center justify-between px-4 py-3">
                    <h3 className="text-sm font-medium">{t("layout.notifications.title")}</h3>
                    {notifications?.unreadCount > 0 && (
                      <button
                        onClick={() => notifications.markAllRead()}
                        className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {t("layout.notifications.markAllRead")}
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto border-t border-border/60">
                    {unreadAlerts.length === 0 ? (
                      <p className="p-6 text-center text-sm text-muted-foreground">
                        {t("layout.notifications.empty")}
                      </p>
                    ) : (
                      unreadAlerts.slice(0, 5).map((alert) => (
                        <div
                          key={alert.id}
                          className="flex items-start gap-3 border-b border-border/60 px-4 py-3 last:border-0"
                        >
                          <span
                            className={`mt-1.5 size-2 shrink-0 rounded-full ${
                              SEVERITY_DOT[alert.severity] || "bg-muted-foreground"
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{TYPE_LABEL_KEYS[alert.alert_type] ? t(TYPE_LABEL_KEYS[alert.alert_type]) : alert.alert_type}</span>
                              {alert.device_name && (
                                <span className="truncate">· {alert.device_name}</span>
                              )}
                            </div>
                            <p className="mt-0.5 text-sm">{notificationMessage(alert, t)}</p>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {formatTime(alert.triggered_at, intlLocale)}{alert.resolved_at ? ` · ${t("layout.notifications.ended")}` : ""}
                            </p>
                          </div>
                          {alert.unread && (
                            <button onClick={() => notifications.markRead(alert.id)} className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground">{t("layout.notifications.markRead")}</button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  <Link
                    href="/notifications"
                    onClick={() => setShowCenter(false)}
                    className="flex w-full items-center justify-between border-t border-border/60 px-4 py-3 text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
                  >
                    {t("layout.notifications.openCenter")}
                    <span aria-hidden="true">→</span>
                  </Link>
                </div>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2 rounded-full pl-1 pr-2 outline-none transition-colors hover:bg-foreground/5">
                <span className="grid size-8 place-items-center rounded-full bg-foreground/5 text-xs font-medium text-foreground">
                  {initials}
                </span>
                <ChevronDown className="size-3 text-muted-foreground" strokeWidth={1.75} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuLabel>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{session.user.name}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {session.user.companyName}
                    </span>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-label">{t("layout.appearance")}</DropdownMenuLabel>
                <div className="px-1.5 pb-1">
                  <div className="grid grid-cols-2 gap-1 rounded-md bg-foreground/5 p-1">
                    {[
                      { value: "light", label: t("layout.theme.light"), icon: Sun },
                      { value: "dark", label: t("layout.theme.dark"), icon: Moon },
                    ].map((opt) => {
                      const Icon = opt.icon;
                      const isActive = theme === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setTheme(opt.value);
                          }}
                          className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                            isActive
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          <Icon className="size-3.5" strokeWidth={1.75} />
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/login" })}>
                  <LogOut className="mr-2 size-4" strokeWidth={1.75} />
                  {t("layout.signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </header>
  );
}
