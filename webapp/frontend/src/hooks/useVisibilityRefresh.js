import { useEffect, useRef } from "react";

/**
 * Calls `onRefresh()` every time the tab becomes visible again.
 * Mobile browsers pause JS/streams in the background, so UI data is often
 * stale on return; this hook reloads it.
 */
export default function useVisibilityRefresh(onRefresh) {
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    function handle() {
      if (document.visibilityState === "visible") {
        onRefreshRef.current?.();
      }
    }
    document.addEventListener("visibilitychange", handle);
    window.addEventListener("focus", handle);
    return () => {
      document.removeEventListener("visibilitychange", handle);
      window.removeEventListener("focus", handle);
    };
  }, []);
}
