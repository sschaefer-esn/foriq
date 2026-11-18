"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

const tabs = [
  { labelKey: "settings.tab.general", href: "/settings/appearance" },
  { labelKey: "settings.tab.account", href: "/settings/account" },
  { labelKey: "settings.tab.firmware", href: "/settings/firmware" },
  { labelKey: "settings.tab.users", href: "/settings/users" },
  { labelKey: "settings.tab.company", href: "/settings/company" },
];

export default function SettingsLayout({ children }) {
  const t = useT();
  const pathname = usePathname();

  return (
    <div>
      <div className="border-b mb-6">
        <nav className="flex gap-4">
          {tabs.map((tab) => {
            const isActive = pathname.startsWith(tab.href);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "pb-3 text-sm font-medium border-b-2 transition-colors",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {t(tab.labelKey)}
              </Link>
            );
          })}
        </nav>
      </div>
      {children}
    </div>
  );
}
