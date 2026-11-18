"use client";

import { useEffect, useMemo, useRef } from "react";
import { formatCountSensitivity } from "@/lib/countingDefaults";
import { useLocale, useT } from "@/lib/i18n";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function formatTime(ms, locale) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const digits = ms < 10000 ? 1 : 0;
  return `${(ms / 1000).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} s`;
}

export default function StrokeMachinePreview({
  sensitivity = 3594,
  bridgeMs = 1500,
  minimumPeakEnergy,
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const ramRef = useRef(null);
  const configRef = useRef(null);

  const config = useMemo(() => {
    const displayCycle = clamp(Number(bridgeMs) || 900, 400, 6000);
    const lockout = Math.round(displayCycle / 2);
    const motionMs = Math.round(displayCycle / 3);
    const strokesPerMinute = Math.round(60000 / displayCycle);
    return {
      lockout, motionMs, strokesPerMinute, displayCycle,
    };
  }, [bridgeMs]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return undefined;
    let frameId = 0;

    const frame = (now) => {
      const current = configRef.current;
      if (!current) {
        frameId = requestAnimationFrame(frame);
        return;
      }
      const elapsed = now % current.displayCycle;
      const motionEnd = current.motionMs;
      let travel = 0;

      if (elapsed < motionEnd) {
        const motion = elapsed / motionEnd;
        if (motion < 0.38) {
          const p = motion / 0.38;
          travel = 21 * (1 - Math.pow(1 - p, 3));
        } else if (motion < 0.56) {
          travel = 21;
        } else {
          const p = (motion - 0.56) / 0.44;
          travel = 21 * (1 - p * p);
        }
      }

      ramRef.current?.setAttribute("transform", `translate(0 ${travel.toFixed(2)})`);
      frameId = requestAnimationFrame(frame);
    };

    frameId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameId);
  }, []);

  const speedText = config.strokesPerMinute > 999
    ? ">999/min"
    : `≈ ${config.strokesPerMinute}/min`;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border/60 bg-muted/20">
      <div className="grid md:grid-cols-[minmax(15rem,0.9fr)_minmax(17rem,1.1fr)]">
        <div className="relative min-h-44 overflow-hidden border-b border-border/60 bg-card md:border-b-0 md:border-r">
          <svg viewBox="0 0 290 176" className="absolute inset-0 size-full" role="img" aria-label={t("devices.preview.aria")}>
            {/* Neutral machine silhouette without a coloured status frame. */}
            <path
              d="M59 32 H231 Q235 32 235 36 V157 H52 V36 Q52 32 59 32 Z M87 60 V136 H202 V60 Z"
              fill="var(--muted)"
              fillRule="evenodd"
            />
            <path d="M87 60 V136 H202 V60 Z" fill="none" stroke="var(--foreground)"
              strokeOpacity="0.18" strokeWidth="1.5" strokeLinejoin="round" />

            {/* Original stroke motion and original tool shape. */}
            <g ref={ramRef}>
              <rect x="116" y="60" width="58" height="24" rx="4" fill="var(--foreground)" opacity="0.68" />
              <path d="M137 84 H153 V104 H164 V109 H126 V104 H137 Z" fill="var(--foreground)" opacity="0.68" />
            </g>

            <rect x="129" y="130" width="32" height="6" rx="1.5" fill="var(--foreground)" opacity="0.58" />
          </svg>
        </div>

        <div className="flex flex-col justify-center p-4">
          <div className="flex items-baseline justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{t("devices.preview.title")}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{t("devices.preview.subtitle")}</div>
            </div>
            <div className="font-mono text-sm font-semibold tabular-nums text-primary">{speedText}</div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <div>
              <div className="text-muted-foreground">{t("devices.preview.period")}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums">{formatTime(config.displayCycle, intlLocale)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("devices.preview.lockout")}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums">{formatTime(config.lockout, intlLocale)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">{t("devices.preview.sensitivity")}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums">
                {formatCountSensitivity(sensitivity)}
              </div>
              {minimumPeakEnergy && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {t("devices.preview.minPeak")} <span className="font-mono tabular-nums">≈ {minimumPeakEnergy}</span>
                </div>
              )}
            </div>
            <div>
              <div className="text-muted-foreground">{t("devices.preview.energyWindow")}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums">
                {formatTime(Math.max(20, Math.round(config.displayCycle / 4)), intlLocale)}
              </div>
            </div>
          </div>

          <p className="mt-4 border-t border-border/60 pt-3 text-[11px] leading-4 text-muted-foreground">
            {t("devices.preview.note")}
          </p>
        </div>
      </div>
    </div>
  );
}
