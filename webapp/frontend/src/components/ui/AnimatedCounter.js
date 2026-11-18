"use client";

import { useEffect, useState } from "react";
import NumberFlow from "@number-flow/react";
import { useLocale } from "@/lib/i18n";

const SPIN_TIMING = { duration: 450, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };

/**
 * Live piece count with a rolling-digit animation (number-flow). The library
 * handles tabular widths itself (measures digit widths, animates the width
 * change 99→100) and respects prefers-reduced-motion natively.
 *
 * `animateOnMount`: number-flow only animates on value changes — behind a
 * loading skeleton the counter mounts with its final value, so nothing would
 * be visible. With this flag it starts at 0 and rolls up to the real value
 * after the first paint.
 */
export default function AnimatedCounter({ value, className = "", animateOnMount = false }) {
  const num = Number(value);
  const { intlLocale } = useLocale();
  const [mounted, setMounted] = useState(!animateOnMount);

  useEffect(() => {
    if (mounted) return;
    // Double rAF: number-flow counts up only once the 0 has really been rendered.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setMounted(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
  }, [mounted]);

  if (!Number.isFinite(num)) {
    return (
      <span className={`tabular-nums inline-block ${className}`}>
        {value == null ? "–" : String(value)}
      </span>
    );
  }

  return (
    <NumberFlow
      value={mounted ? Math.max(0, Math.floor(num)) : 0}
      locales={intlLocale}
      format={{ useGrouping: false }}
      spinTiming={SPIN_TIMING}
      transformTiming={SPIN_TIMING}
      willChange
      className={className}
    />
  );
}
