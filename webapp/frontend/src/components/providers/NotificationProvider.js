"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { useT } from "@/lib/i18n";
import { notificationMessage } from "@/lib/notificationMessage";

const NotificationContext = createContext(null);

export function useNotifications() {
  return useContext(NotificationContext);
}

export default function NotificationProvider({ children }) {
  const t = useT();
  const [alerts, setAlerts] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const knownStates = useRef(new Map());
  const initialized = useRef(false);

  const showToast = useCallback((alert) => {
    const toastId = `${alert.id}-${Date.now()}`;
    setToasts((current) => [{ ...alert, toastId }, ...current].slice(0, 3));
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.toastId !== toastId)), 8000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api.get("/notifications");
      if (initialized.current) {
        data.filter((alert) => {
          const state = alert.resolved_at || "active";
          return knownStates.current.get(alert.id) !== state;
        }).filter((alert) => !(
          alert.resolution === "activity_resumed"
          && alert.notify_activity_resumed === false
        )).forEach(showToast);
      }
      knownStates.current = new Map(data.map((alert) => [alert.id, alert.resolved_at || "active"]));
      initialized.current = true;
      setAlerts(data);
    } catch {
      // A failed poll keeps the last reliable state.
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    const initialTimer = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 30000);
    const handleVisibility = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => { clearTimeout(initialTimer); clearInterval(timer); document.removeEventListener("visibilitychange", handleVisibility); };
  }, [refresh]);

  const markRead = useCallback(async (alertId) => {
    await api.post(`/notifications/${alertId}/read`);
    setAlerts((current) => current.map((alert) => alert.id === alertId ? { ...alert, unread: false } : alert));
  }, []);

  const markAllRead = useCallback(async () => {
    await api.post("/notifications/read-all");
    setAlerts((current) => current.map((alert) => ({ ...alert, unread: false })));
  }, []);

  return (
    <NotificationContext.Provider value={{
      alerts,
      loading,
      unreadCount: alerts.filter((alert) => alert.unread).length,
      markRead,
      markAllRead,
      refresh,
    }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed right-4 top-4 z-[100] flex max-w-[380px] flex-col gap-2" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.toastId} className="animate-in slide-in-from-right-4 rounded-xl border border-border bg-popover p-3 text-sm shadow-lg">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <span className={`size-1.5 shrink-0 rounded-full ${toast.resolved_at ? "bg-emerald-500" : "bg-destructive"}`} />
                    <span className="truncate">{toast.device_name}</span>
                  </p>
                  <p className="mt-0.5 text-muted-foreground">{notificationMessage(toast, t)}</p>
                </div>
                <button onClick={() => setToasts((current) => current.filter((item) => item.toastId !== toast.toastId))} className="text-muted-foreground" aria-label={t("notifications.dismissToast")}>×</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </NotificationContext.Provider>
  );
}
