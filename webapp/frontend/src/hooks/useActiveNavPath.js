"use client";

import { usePathname } from "next/navigation";

// The sensor detail view is an overlay (?device=…) on top of the page it was
// opened from, whose menu entry stays active.
export default function useActiveNavPath() {
  return usePathname();
}
