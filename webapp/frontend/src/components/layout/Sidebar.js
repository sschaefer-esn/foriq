"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import useActiveNavPath from "@/hooks/useActiveNavPath";
import ForiqLogo from "@/components/ui/ForiqLogo";
import { getNavItems } from "@/components/layout/navItems";
import { useNotifications } from "@/components/providers/NotificationProvider";
import { useT } from "@/lib/i18n";

export default function Sidebar() {
  const pathname = useActiveNavPath();
  const notifications = useNotifications();
  const t = useT();
  const items = getNavItems();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border/60 bg-sidebar md:block">
      <div className="flex h-16 items-center px-6">
        <Link href="/dashboard" aria-label="Foriq">
          <ForiqLogo className="h-8 w-auto text-foreground" />
        </Link>
      </div>
      <nav className="space-y-0.5 px-3 pt-2">
        {items.map((item) => {
          const active = item.matches.some((m) => pathname.startsWith(m));
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-foreground/5 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              )}
            >
              <Icon
                className={cn(
                  "size-[18px] shrink-0 transition-colors",
                  active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1">{t(item.labelKey)}</span>
              {item.badge === "notifications" && notifications?.unreadCount > 0 && (
                <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground tabular-nums" aria-label={t("layout.unreadNotifications", { count: notifications.unreadCount })}>
                  {notifications.unreadCount > 99 ? "99+" : notifications.unreadCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
