"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { translate } from "@/lib/i18n";

const STORAGE_PREFIX = "foriq_pending_settings_";
const SAVED_PHASE_MS = 900;
// Sleeping sensors normally check in only after up to 15 minutes.
const PENDING_TIMEOUT_MS = 20 * 60 * 1000;
const APPLIED_VISIBLE_MS = 6000;

export function usePendingSettings(deviceId) {
  const storageKey = STORAGE_PREFIX + deviceId;

  const [pendingFields, setPendingFields] = useState(() => {
    if (typeof window === "undefined") return {};
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const pendingFieldsRef = useRef(pendingFields);
  const [lastTransition, setLastTransition] = useState(null);

  // Persist to localStorage on every change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (Object.keys(pendingFields).length === 0) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, JSON.stringify(pendingFields));
      }
    } catch {
      // localStorage may be unavailable
    }
  }, [pendingFields, storageKey]);

  const addPending = useCallback((fieldName, value) => {
    const changedAt = Date.now();
    const next = {
      ...pendingFieldsRef.current,
      [fieldName]: { value, changedAt, phase: "saved" },
    };
    pendingFieldsRef.current = next;
    setPendingFields(next);
    setLastTransition(null);
  }, []);

  const addPendingFields = useCallback((fields) => {
    if (!fields || Object.keys(fields).length === 0) return;
    const changedAt = Date.now();
    const next = { ...pendingFieldsRef.current };
    for (const [fieldName, value] of Object.entries(fields)) {
      next[fieldName] = { value, changedAt, phase: "saved" };
    }
    pendingFieldsRef.current = next;
    setPendingFields(next);
    setLastTransition(null);
  }, []);

  const resolvePending = useCallback((upstreamConfig) => {
    if (!upstreamConfig) return;
    const next = { ...pendingFieldsRef.current };
    const resolvedFields = [];
    let deliveryChanged = false;
    for (const [field, entry] of Object.entries(pendingFieldsRef.current)) {
      if (!(field in upstreamConfig)) continue;
      const up = upstreamConfig[field];
      const pend = entry.value;
      // Float comparison with tolerance (C++ float has ~7 digits precision)
      const match =
        typeof up === "number" && typeof pend === "number"
          ? Math.abs(up - pend) < Math.max(Math.abs(pend), 1e-9) * 0.01
          : up === pend || JSON.stringify(up) === JSON.stringify(pend);
      if (match) {
        // The first matching sync delivers the new target value to the sensor.
        // Only the following sync is certain to come after it was applied, so
        // the HTTP fetch itself is not reported as "applied".
        if (entry.deliveredAt) {
          delete next[field];
          resolvedFields.push(field);
        } else {
          next[field] = { ...entry, phase: "waiting", deliveredAt: Date.now() };
          deliveryChanged = true;
        }
      }
    }
    if (resolvedFields.length === 0 && !deliveryChanged) return;
    pendingFieldsRef.current = next;
    setPendingFields(next);
    if (resolvedFields.length === 0) return;
    setLastTransition({
      phase: "applied",
      fields: resolvedFields,
      changedAt: Date.now(),
    });
  }, []);

  const markFailed = useCallback((fieldNames, message) => {
    const fields = Array.isArray(fieldNames) ? fieldNames : [fieldNames].filter(Boolean);
    const next = { ...pendingFieldsRef.current };
    fields.forEach((field) => delete next[field]);
    pendingFieldsRef.current = next;
    setPendingFields(next);
    setLastTransition({
      phase: "error",
      fields,
      message: message || translate("common.pendingSettings.saveFailed"),
      changedAt: Date.now(),
    });
  }, []);

  // After the server confirms, the display deliberately switches briefly from
  // "saved" to "waiting for sensor". This is not a fake progress indicator:
  // it separates the two real confirmation points.
  useEffect(() => {
    const saved = Object.values(pendingFields).filter((entry) => (entry.phase || "saved") === "saved");
    if (saved.length === 0) return;
    const oldestRemaining = Math.min(...saved.map((entry) => Math.max(0, SAVED_PHASE_MS - (Date.now() - entry.changedAt))));
    const timer = setTimeout(() => {
      const now = Date.now();
      const next = Object.fromEntries(
        Object.entries(pendingFieldsRef.current).map(([field, entry]) => [
          field,
          now - entry.changedAt >= SAVED_PHASE_MS ? { ...entry, phase: "waiting" } : entry,
        ]),
      );
      pendingFieldsRef.current = next;
      setPendingFields(next);
    }, oldestRemaining + 10);
    return () => clearTimeout(timer);
  }, [pendingFields]);

  // A sensor that never fetches the change is not removed silently but shown
  // as an unconfirmed transfer.
  useEffect(() => {
    if (Object.keys(pendingFields).length === 0) return;
    const id = setInterval(() => {
      const next = { ...pendingFieldsRef.current };
      const timedOut = [];
      const now = Date.now();
      for (const [field, entry] of Object.entries(pendingFieldsRef.current)) {
        if (now - entry.changedAt > PENDING_TIMEOUT_MS) {
          delete next[field];
          timedOut.push(field);
        }
      }
      if (timedOut.length === 0) return;
      pendingFieldsRef.current = next;
      setPendingFields(next);
      setLastTransition({
        phase: "error",
        fields: timedOut,
        message: translate("common.pendingSettings.notConfirmed"),
        changedAt: now,
      });
    }, 30000);
    return () => clearInterval(id);
  }, [pendingFields]);

  useEffect(() => {
    if (lastTransition?.phase !== "applied") return;
    const remaining = Math.max(0, APPLIED_VISIBLE_MS - (Date.now() - lastTransition.changedAt));
    const timer = setTimeout(() => setLastTransition(null), remaining);
    return () => clearTimeout(timer);
  }, [lastTransition]);

  const clearAll = useCallback(() => {
    pendingFieldsRef.current = {};
    setPendingFields({});
    setLastTransition(null);
  }, []);

  const dismissStatus = useCallback(() => setLastTransition(null), []);

  const hasPending = Object.keys(pendingFields).length > 0;
  const settingsStatus = useMemo(() => {
    const entries = Object.values(pendingFields);
    if (entries.length > 0) {
      const phase = entries.some((entry) => (entry.phase || "saved") === "waiting")
        ? "waiting"
        : "saved";
      return { phase, count: entries.length, changedAt: Math.max(...entries.map((entry) => entry.changedAt)) };
    }
    return lastTransition ? { ...lastTransition, count: lastTransition.fields?.length || 0 } : null;
  }, [lastTransition, pendingFields]);

  return {
    pendingFields,
    addPending,
    addPendingFields,
    resolvePending,
    markFailed,
    clearAll,
    dismissStatus,
    hasPending,
    settingsStatus,
  };
}
