"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import DeviceDetail from "@/components/devices/DeviceDetail";
import { DEVICE_PARAM } from "@/hooks/useDeviceHref";
import { DUR } from "@/lib/motion";
import { useT } from "@/lib/i18n";

// Sensor detail as an overlay above the current page (?device=<id>). Covers the
// main area OPAQUELY; the originating page stays mounted underneath (scroll and
// sidebar selection are kept). Deliberately just a calm opacity fade.
// Close: opened from within the app → router.back() (URL returns to the origin);
// on direct access/reload there is no origin → remove the parameter.
export default function DeviceOverlay() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const id = searchParams.get(DEVICE_PARAM);
  // If the page was shown without the overlay before, the origin is in the history.
  const sawWithoutOverlay = useRef(false);
  useEffect(() => {
    if (!id) sawWithoutOverlay.current = true;
  }, [id]);

  const close = useCallback(() => {
    if (sawWithoutOverlay.current) {
      router.back();
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.delete(DEVICE_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  // Esc closes the overlay
  useEffect(() => {
    if (!id) return;
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id, close]);

  return (
    <AnimatePresence>
      {id && (
        <motion.div
          key="device-modal"
          className="absolute inset-0 z-30 overflow-hidden bg-background"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: DUR.fast }}
        >
          <div className="h-full overflow-y-auto px-4 pb-6 md:px-8 md:pb-10 [scrollbar-gutter:stable_both-edges]">
            <div className="mx-auto w-full max-w-3xl">
              <DeviceDetail
                key={id}
                id={id}
                closeButton={
                  <button
                    type="button"
                    onClick={close}
                    aria-label={t("devices.overlay.close")}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  >
                    <X className="size-[18px]" strokeWidth={1.75} />
                  </button>
                }
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
