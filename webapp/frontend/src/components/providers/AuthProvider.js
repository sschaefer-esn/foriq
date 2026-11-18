"use client";

import { useEffect } from "react";
import { refreshIfNeeded, syncFromStorage } from "@/lib/auth";

// Keeps the session fresh: renews the token in time (also for an open, idle
// tab) and picks up sign-ins/sign-outs from other tabs.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export default function AuthProvider({ children }) {
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === "visible") refreshIfNeeded();
    };
    check();
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("storage", syncFromStorage);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("storage", syncFromStorage);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  return children;
}
