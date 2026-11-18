"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DUR, EASE } from "@/lib/motion";
import useActiveNavPath from "@/hooks/useActiveNavPath";
import ForiqLogo from "@/components/ui/ForiqLogo";
import { getNavItems } from "@/components/layout/navItems";
import { useNotifications } from "@/components/providers/NotificationProvider";
import { useT } from "@/lib/i18n";

export default function MobileMenu() {
  const pathname = useActiveNavPath();
  const notifications = useNotifications();
  const t = useT();
  const [open, setOpen] = useState(false);
  const items = getNavItems();

  // Close on navigation
  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), 0);
    return () => clearTimeout(timer);
  }, [pathname]);

  // Escape closes; lock body scroll while open
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        onClick={() => setOpen(true)}
        className="-ml-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        aria-label={t("layout.menu.open")}
      >
        <Menu className="size-[22px]" strokeWidth={1.75} />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-50 bg-foreground/30 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DUR.base, ease: EASE }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[80vw] flex-col border-r border-border/60 bg-sidebar"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: DUR.slow, ease: EASE }}
            >
              <div className="flex h-16 items-center justify-between px-5">
                <Link href="/dashboard" aria-label="Foriq" onClick={() => setOpen(false)}>
                  <ForiqLogo className="h-8 w-auto text-foreground" />
                </Link>
                <button
                  onClick={() => setOpen(false)}
                  className="-mr-1 rounded-md p-2 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  aria-label={t("layout.menu.close")}
                >
                  <X className="size-5" strokeWidth={1.75} />
                </button>
              </div>
              <nav className="space-y-0.5 px-3 pt-2">
                {items.map((item) => {
                  const active = item.matches.some((m) => pathname.startsWith(m));
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
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
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
