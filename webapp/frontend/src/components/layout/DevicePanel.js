"use client";

import { useT } from "@/lib/i18n";

export default function DevicePanel({ devices, placedDeviceIds }) {
  const t = useT();
  const available = devices.filter(
    (d) => !placedDeviceIds.includes(d.id)
  );

  if (available.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-4">
        {t("floorPlan.panel.allPlaced")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{t("floorPlan.panel.available")}</p>
      {available.map((device) => (
        <div
          key={device.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("device_id", device.id);
            e.dataTransfer.setData("device_name", device.name);
            e.dataTransfer.effectAllowed = "copy";
          }}
          className="rounded-md border bg-card px-3 py-2 text-sm cursor-grab active:cursor-grabbing hover:border-primary/50 transition-colors"
        >
          {device.name}
        </div>
      ))}
    </div>
  );
}
