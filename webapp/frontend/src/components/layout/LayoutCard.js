"use client";

import { X } from "lucide-react";
import DashboardCard from "@/components/devices/DashboardCard";
import { useT } from "@/lib/i18n";

export default function LayoutCard({
  item, cols, rows, editing, dragging, onPointerDownMove, onRemove,
}) {
  const t = useT();
  const style = {
    left: `${(item.x / cols) * 100}%`,
    top: `${(item.y / rows) * 100}%`,
    width: `${(item.w / cols) * 100}%`,
    height: `${(item.h / rows) * 100}%`,
  };

  return (
    <div
      className={`absolute ${editing ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${dragging ? "z-20 ring-2 ring-primary ring-offset-2" : "z-10"}`}
      style={style}
      onPointerDown={editing ? onPointerDownMove : undefined}
    >
      <DashboardCard
        device={item}
        href={editing ? null : undefined}
        className={editing ? "pointer-events-none" : ""}
      />
      {editing && (
        <button className="absolute right-2 top-2 z-30 grid size-7 place-items-center rounded-full bg-card/90 text-muted-foreground shadow-sm backdrop-blur hover:text-destructive" onClick={(event) => { event.stopPropagation(); onRemove(); }} aria-label={t("floorPlan.removeMachine")}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
