import { useEffect, useRef } from "react";
import { API_BASE, getAccessToken, handleUnauthorized } from "@/lib/auth";
import { createHitDeduplicator } from "@/lib/liveHits";

const RECONNECT_DELAY = 3000;
const FAST_RECONNECT_DELAY = 100;

export default function useEventStream(onEvent) {
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const aliveRef = { current: true };
    let controller = null;
    let reconnectTimer = null;
    const acceptHit = createHitDeduplicator();

    function scheduleReconnect(delay) {
      if (!aliveRef.current) return;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    async function connect() {
      if (!aliveRef.current || controller) return;
      const connection = new AbortController();
      controller = connection;
      const isCurrent = () => aliveRef.current && controller === connection && !connection.signal.aborted;

      try {
        const token = await getAccessToken();
        if (!isCurrent() || !token) return;
        const response = await fetch(`${API_BASE}/events/stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: connection.signal,
        });
        if (!isCurrent()) return;
        if (response.status === 401) {
          handleUnauthorized();
          return;
        }
        if (!response.ok || !response.body) throw new Error("SSE-Verbindung fehlgeschlagen");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // eventType/eventData MUST survive across reader.read() calls: an SSE
        // event can arrive split over several chunks (event: line in one read(),
        // data:/blank line only in the next). Resetting them per chunk inside the
        // while loop lost events split across chunk boundaries (visible under
        // high event volume such as the 1 s settings_sync flood of fast sync).
        let eventType = null;
        let eventData = null;

        while (isCurrent()) {
          const { done, value } = await reader.read();
          if (done || !isCurrent()) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7);
            } else if (line.startsWith("data: ")) {
              eventData = line.slice(6);
            } else if (line === "" && eventType && eventData) {
              try {
                const data = JSON.parse(eventData);
                if (isCurrent() && (eventType !== "hit" || acceptHit(data))) {
                  onEventRef.current({ type: eventType, data });
                }
              } catch {
                // ignore malformed JSON
              }
              eventType = null;
              eventData = null;
            }
          }
        }
      } catch {
        // Network/session errors are handled like a regular end of stream.
      } finally {
        // Only the current connection may schedule its successor. Aborted
        // streams must neither set a second timer nor deliver events.
        if (isCurrent()) {
          connection.abort();
          controller = null;
          scheduleReconnect(RECONNECT_DELAY);
        }
      }
    }

    function forceReconnect() {
      if (controller) controller.abort();
      controller = null;
      scheduleReconnect(FAST_RECONNECT_DELAY);
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") forceReconnect();
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleVisibility);
    connect();

    return () => {
      aliveRef.current = false;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleVisibility);
      if (controller) controller.abort();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    };
  }, []);
}
