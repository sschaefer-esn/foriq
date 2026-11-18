"use client";

import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";

// Client caches shared between overview pages and the detail page, so that
// navigating back and forth never shows a blank skeleton.
//
//  - Every overview page persists its last loaded sensor list under its own
//    key. On (re)mount it renders from the cache immediately and only
//    revalidates in the background → no skeleton when going "back".
//  - The detail page takes its seed (basic sensor data) from exactly these
//    lists, so header and counter are there instantly.
//
// Deliberately NO SWR fetcher of its own: the keys are only filled manually by
// the pages. The existing SSE patch logic stays untouched.
export const OVERVIEW_LIST_KEY = "list:dashboard-overview";
export const DEVICES_LIST_KEY = "list:devices";

const READ_OPTS = {
  revalidateOnMount: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
};

/**
 * Persisted list cache for an overview page.
 * `data` is the cached array (or null), `write` stores without refetching.
 */
export function useCachedDeviceList(key) {
  const { data } = useSWR(key, null, READ_OPTS);
  const { mutate } = useSWRConfig();
  const write = useCallback((list) => mutate(key, list, false), [mutate, key]);
  return { data: data || null, write };
}

/** Reads the cached sensor row for `id` from one of the lists (or null). */
export function useDeviceSeed(id) {
  const { data: overview } = useSWR(OVERVIEW_LIST_KEY, null, READ_OPTS);
  const { data: devices } = useSWR(DEVICES_LIST_KEY, null, READ_OPTS);
  if (id == null) return null;
  const match = (arr) => arr?.find((d) => String(d?.id) === String(id));
  return match(overview) || match(devices) || null;
}
