"use client";

import { useEffect, useState } from "react";

/**
 * Ticking timestamp: re-renders the component every intervalMs so derived
 * times ("stopped for X min", "X min ago") stay current without polling.
 */
export default function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
