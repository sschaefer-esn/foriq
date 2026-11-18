import { LayoutDashboard, LayoutGrid, BarChart3, Table2, Cpu, Settings, BellRing } from "lucide-react";

export const navigation = [
  { labelKey: "layout.nav.dashboard", href: "/dashboard", icon: LayoutDashboard, matches: ["/dashboard"] },
  { labelKey: "layout.nav.notifications", href: "/notifications", icon: BellRing, matches: ["/notifications"], badge: "notifications" },
  { labelKey: "layout.nav.sensors", href: "/devices", icon: Cpu, matches: ["/devices"] },
  { labelKey: "layout.nav.floorPlan", href: "/floor-plan", icon: LayoutGrid, matches: ["/floor-plan"] },
  { labelKey: "layout.nav.data", href: "/data", icon: Table2, matches: ["/data"] },
  { labelKey: "layout.nav.export", href: "/export", icon: BarChart3, matches: ["/export"] },
];

export const settingsItem = {
  labelKey: "layout.nav.settings",
  href: "/settings/appearance",
  icon: Settings,
  matches: ["/settings"],
};

/** Navigation entries including settings. */
export function getNavItems() {
  return [...navigation, settingsItem];
}
