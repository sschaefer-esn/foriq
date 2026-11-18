"use client";

import { useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export const DEVICE_PARAM = "device";

// Sensor detail as an overlay on the current page: append ?device=<id> to the
// current URL (other query parameters such as ?tab= are kept).
export default function useDeviceHref() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (id) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(DEVICE_PARAM, id);
      return `${pathname}?${params.toString()}`;
    },
    [pathname, searchParams],
  );
}
