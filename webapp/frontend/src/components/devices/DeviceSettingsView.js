"use client";

import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { DUR, EASE, SPRING } from "@/lib/motion";
import DeviceConfig from "./DeviceConfig";
import DeviceManagement from "./DeviceManagement";
import { useT } from "@/lib/i18n";

const TABS = [
  { id: "overview", labelKey: "devices.tab.overview" },
  { id: "config", labelKey: "devices.tab.config" },
  { id: "hardware", labelKey: "devices.tab.hardware" },
];

export default function DeviceSettingsView({
  activeTab, onTabChange, header, overviewSlot, device,
  onConfigChanged, onSettingSaved, onSettingError, lastCommandEvent,
  onClearPendingSettings, settingsStatusSlot, hasSettingsStatus,
}) {
  const t = useT();
  return (
    <div>
      <div className="sticky top-0 z-10 bg-background pt-2 md:pt-4">
        {header && <div className="pb-4">{header}</div>}
        <nav className="border-b border-border/60">
          <div role="tablist" className="flex gap-1">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              return <button key={tab.id} role="tab" aria-selected={active} onClick={() => onTabChange?.(tab.id)} className={cn("relative px-3 py-3 text-sm font-medium", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>{t(tab.labelKey)}{active && <motion.span layoutId="device-tab-indicator" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary" transition={SPRING} />}</button>;
            })}
          </div>
        </nav>
        {(settingsStatusSlot && (activeTab === "config" || hasSettingsStatus)) && (
          <div className="pb-2 pt-2">{settingsStatusSlot}</div>
        )}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={activeTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: { duration: DUR.fast, ease: EASE } }} transition={{ duration: DUR.base, ease: EASE }} className="pt-6">
          {activeTab === "overview" && overviewSlot}
          {activeTab === "config" && <DeviceConfig device={device} onConfigChanged={onConfigChanged} onSettingSaved={onSettingSaved} onSettingError={onSettingError} />}
          {activeTab === "hardware" && <DeviceManagement device={device} onDeviceChanged={onConfigChanged} sseEvent={lastCommandEvent} onClearPendingSettings={onClearPendingSettings} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
