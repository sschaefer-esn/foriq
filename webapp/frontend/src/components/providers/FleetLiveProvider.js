"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import api from "@/lib/api";
import { pushLiveHit } from "@/lib/stall";
import useEventStream from "@/hooks/useEventStream";
import useVisibilityRefresh from "@/hooks/useVisibilityRefresh";
import { OVERVIEW_LIST_KEY, useCachedDeviceList } from "@/hooks/useDeviceSeed";
import { useNotifications } from "@/components/providers/NotificationProvider";

const FleetLiveContext = createContext(null);

export function useFleetLive() {
  const context = useContext(FleetLiveContext);
  if (!context) throw new Error("useFleetLive must be used within FleetLiveProvider");
  return context;
}

function withLiveState(devices) {
  const loadedAt = Date.now();
  return devices.map((device) => ({
    ...device,
    rate_loaded_at: loadedAt,
    live_hit_times: [],
  }));
}

export default function FleetLiveProvider({ children }) {
  const notifications = useNotifications();
  const { data: cached, write } = useCachedDeviceList(OVERVIEW_LIST_KEY);
  const [devices, setDevices] = useState(() => cached || []);
  const [loading, setLoading] = useState(() => !cached);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get("/dashboard/overview");
      setDevices(withLiveState(data));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (devices.length) write(devices); }, [devices, write]);

  const handleEvent = useCallback((event) => {
    const deviceId = event.data?.device_id;
    if (event.type === "notification") {
      refresh();
      notifications?.refresh();
      return;
    }
    if (!deviceId) return;

    if (event.type === "production_updated") {
      setDevices((current) => current.map((device) => device.id === deviceId
        ? { ...device, production: event.data.production ?? null }
        : device));
      return;
    }

    if (event.type === "hit") {
      setDevices((current) => current.map((device) => {
        if (device.id !== deviceId) return device;
        const hitDate = new Date(event.data.recorded_at);
        hitDate.setMinutes(0, 0, 0);
        const bucket = hitDate.toLocaleString("sv-SE").replace(" ", "T").slice(0, 13) + ":00:00";
        const chart = [...(device.chart || [])];
        const hasBucket = chart.some((entry) => entry.bucket === bucket);
        return {
          ...device,
          count_today: (device.count_today || 0) + 1,
          last_seen_at: event.data.last_seen_at || device.last_seen_at,
          last_hit_at: event.data.recorded_at || device.last_hit_at,
          live_hit_times: pushLiveHit(device.live_hit_times),
          active_incident: null,
          production: device.production && new Date(event.data.recorded_at).getTime() >= new Date(device.production.started_at).getTime()
            ? {
                ...device.production,
                current_count: (device.production.current_count || 0) + 1,
                remaining_count: Math.max(0, device.production.target_count - (device.production.current_count || 0) - 1),
                material_remaining: device.production.material_count == null
                  ? null
                  : Math.max(0, device.production.material_count - (device.production.current_count || 0) - 1),
              }
            : device.production,
          chart: hasBucket
            ? chart.map((entry) => entry.bucket === bucket ? { ...entry, count: entry.count + 1 } : entry)
            : [...chart, { bucket, count: 1 }].sort((a, b) => a.bucket.localeCompare(b.bucket)),
        };
      }));
      return;
    }

    if (event.type === "status" || event.type === "settings_sync") {
      setDevices((current) => current.map((device) => device.id === deviceId ? {
        ...device,
        last_seen_at: event.data.last_seen_at || device.last_seen_at,
        sleep_mode: event.data.sleep_mode ?? device.sleep_mode,
      } : device));
    }
  }, [notifications, refresh]);

  useEventStream(handleEvent);
  useVisibilityRefresh(refresh);

  return (
    <FleetLiveContext.Provider value={{ devices, loading, refresh }}>
      {children}
    </FleetLiveContext.Provider>
  );
}
