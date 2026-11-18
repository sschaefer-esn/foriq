"use client";

import { useCallback, useEffect, useState } from "react";
import { Radio } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";

// Self-hosted installation: sensors register themselves after Wi-Fi setup and
// wait here for approval. If the backend answers 404 the section stays hidden.
const POLL_MS = 5000;

export default function PendingDevices({ onApproved }) {
  const t = useT();
  const [devices, setDevices] = useState([]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    try {
      const { data } = await api.get("/devices/pending");
      setDevices(data);
    } catch (error) {
      if (error?.response?.status === 404) setAvailable(false);
    }
  }, []);

  useEffect(() => {
    if (!available) return undefined;
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [available, load]);

  async function decide(device, approve) {
    setBusy(device.id);
    setMessage("");
    try {
      if (approve) {
        await api.post(`/devices/pending/${device.id}/approve`);
        setMessage(t("devices.pendingList.approved", { name: device.name }));
        onApproved?.();
      } else {
        await api.delete(`/devices/pending/${device.id}`);
      }
      await load();
    } catch {
      setMessage(t("devices.pendingList.actionFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (!available || (devices.length === 0 && !message)) return null;

  return (
    <section className="mt-5 max-w-3xl rounded-xl border border-border/60 bg-card p-4 shadow-card">
      <div className="flex gap-2">
        <Radio className="mt-0.5 size-4 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">{t("devices.pendingList.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t("devices.pendingList.subtitle")}</p>
        </div>
      </div>
      {devices.length > 0 && (
        <ul className="mt-3 divide-y divide-border/60">
          {devices.map((device) => (
            <li key={device.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm">{device.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {device.reconnect
                    ? t("devices.pendingList.reconnect")
                    : t("devices.pendingList.serial", { serial: device.serial_number })}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => decide(device, true)} disabled={busy === device.id}>{t("devices.pendingList.approve")}</Button>
                <Button size="sm" variant="outline" onClick={() => decide(device, false)} disabled={busy === device.id}>{t("devices.pendingList.reject")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-3 text-xs text-muted-foreground" role="status">{message}</p>}
    </section>
  );
}
