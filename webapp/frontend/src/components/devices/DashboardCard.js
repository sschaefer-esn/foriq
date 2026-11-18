"use client";

import Link from "next/link";
import MachineSummaryContent from "@/components/devices/MachineSummaryContent";
import useDeviceHref from "@/hooks/useDeviceHref";

export default function DashboardCard({ device, isToday = true, href, className = "" }) {
  const deviceHref = useDeviceHref();
  const target = href === undefined && device?.id ? deviceHref(device.id) : href;
  const classes = `group block h-full overflow-hidden rounded-2xl border bg-card p-5 shadow-card transition ${target ? "hover:-translate-y-px hover:shadow-card-hover" : ""} ${device?.active_incident ? "border-amber-500/30" : "border-border/60"} ${className}`;
  const content = <MachineSummaryContent device={device} isToday={isToday} />;

  if (!target) return <div className={classes}>{content}</div>;

  return <Link href={target} className={classes}>{content}</Link>;
}
