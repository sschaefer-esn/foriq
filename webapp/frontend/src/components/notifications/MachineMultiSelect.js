"use client";

import { Check, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/lib/i18n";

export default function MachineMultiSelect({
  devices,
  value,
  onChange,
  disabled = false,
  unavailableDeviceRules = {},
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const unnamed = t("notifications.unnamedMachine");
  const [query, setQuery] = useState("");
  const selectedIds = useMemo(
    () => new Set((value || []).map((id) => String(id))),
    [value],
  );
  const sortedDevices = useMemo(
    () => [...(devices || [])].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", intlLocale)),
    [devices, intlLocale],
  );
  const filteredDevices = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(intlLocale);
    if (!normalized) return sortedDevices;
    return sortedDevices.filter((device) =>
      (device.name || unnamed)
        .toLocaleLowerCase(intlLocale)
        .includes(normalized),
    );
  }, [query, sortedDevices, intlLocale, unnamed]);
  const selectableDevices = useMemo(
    () => sortedDevices.filter((device) => !unavailableDeviceRules[String(device.id)]),
    [sortedDevices, unavailableDeviceRules],
  );

  function toggle(deviceId) {
    const id = String(deviceId);
    if (unavailableDeviceRules[id]) return;
    onChange?.(
      selectedIds.has(id)
        ? (value || []).filter((entry) => String(entry) !== id)
        : [...(value || []), deviceId],
    );
  }

  function toggleAll() {
    const allSelected = selectableDevices.length > 0
      && selectableDevices.every((device) => selectedIds.has(String(device.id)));
    onChange?.(allSelected ? [] : selectableDevices.map((device) => device.id));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="flex flex-col gap-2 border-b border-border/60 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={disabled}
            placeholder={t("notifications.select.searchPlaceholder")}
            aria-label={t("notifications.select.searchAria")}
            className="h-8 bg-background pl-8"
          />
        </div>
        <button
          type="button"
          onClick={toggleAll}
          disabled={disabled || selectableDevices.length === 0}
          className="shrink-0 rounded-md px-2 py-1 text-left text-xs font-medium text-primary outline-none transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {selectableDevices.length > 0
          && selectableDevices.every((device) => selectedIds.has(String(device.id)))
            ? t("notifications.select.clear")
            : t("notifications.select.all")}
        </button>
      </div>

      <div className="max-h-56 overflow-y-auto p-2">
        {filteredDevices.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {t("notifications.select.noneFound")}
          </p>
        ) : (
          filteredDevices.map((device) => {
            const selected = selectedIds.has(String(device.id));
            const assignedRuleName = unavailableDeviceRules[String(device.id)];
            const unavailable = Boolean(assignedRuleName);
            const inputId = `rule-device-${device.id}`;
            return (
              <label
                key={device.id}
                htmlFor={inputId}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none transition-colors",
                  selected ? "bg-primary/10" : "hover:bg-muted/50",
                  (disabled || unavailable) && "cursor-not-allowed opacity-60",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded border transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background",
                  )}
                  aria-hidden="true"
                >
                  {selected && <Check className="size-3" strokeWidth={2.5} />}
                </span>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={selected}
                  disabled={disabled || unavailable}
                  onChange={() => toggle(device.id)}
                  className="sr-only"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {device.name || unnamed}
                  </span>
                  {assignedRuleName && (
                    <span className="mt-0.5 block truncate text-xs font-normal text-muted-foreground">
                      {t("notifications.select.alreadyIn", { name: assignedRuleName })}
                    </span>
                  )}
                </span>
              </label>
            );
          })
        )}
      </div>

      <div className="border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {selectedIds.size === 0
          ? t("notifications.select.noneSelected")
          : t("notifications.select.selected", { count: selectedIds.size })}
      </div>
    </div>
  );
}
