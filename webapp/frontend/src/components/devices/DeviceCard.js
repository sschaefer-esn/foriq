"use client";

import Link from "next/link";
import MachineSummaryContent from "@/components/devices/MachineSummaryContent";
import useDeviceHref from "@/hooks/useDeviceHref";

export default function DeviceCard({ device }) {
  const deviceHref = useDeviceHref();
  return (
    <Link href={deviceHref(device?.id)} className="block rounded-xl border border-border/60 bg-card p-4 shadow-card transition hover:-translate-y-px hover:shadow-card-hover">
      <MachineSummaryContent device={device} />
    </Link>
  );
}
