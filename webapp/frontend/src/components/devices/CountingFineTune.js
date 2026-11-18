"use client";

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import StrokeMachinePreview from "@/components/devices/StrokeMachinePreview";
import {
  COUNT_SENSITIVITY_LEVELS,
  DEFAULT_COUNT_BRIDGE_MS,
  DEFAULT_COUNT_SENSITIVITY_BP,
  ENERGY_FS,
  ENERGY_TELEMETRY_FS,
  formatCountSensitivity,
  levelToSensitivity,
  normalizeCountSensitivity,
  sensitivityToLevel,
  sensitivityToEnergyThreshold,
} from "@/lib/countingDefaults";
import { useLocale, useT } from "@/lib/i18n";

const SPEED_LEVELS = 100;

function durationToSpeedLevel(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return SPEED_LEVELS;
  const clamped = Math.max(min, Math.min(max, n));
  return Math.round(SPEED_LEVELS * Math.log(max / clamped) / Math.log(max / min));
}

function speedLevelToDuration(level, min, max, step) {
  const n = Math.max(0, Math.min(SPEED_LEVELS, Math.round(Number(level))));
  const raw = max * Math.pow(min / max, n / SPEED_LEVELS);
  return Math.max(min, Math.min(max, Math.round(raw / step) * step));
}

function formatRate(bridgeMs) {
  const perMinute = Math.round(60000 / Math.max(400, Number(bridgeMs)));
  return perMinute > 999 ? ">999/min" : `≈ ${perMinute}/min`;
}

function formatChanged(value, t, intlLocale) {
  if (!value) return t("deviceDetail.fineTune.default");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("deviceDetail.fineTune.setManually");
  return t("deviceDetail.fineTune.changedOn", { date: date.toLocaleDateString(intlLocale) });
}

function MainSensitivity({ value, minimumPeakEnergy, date, disabled, onChange, onCommit, explanation }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const level = sensitivityToLevel(value);
  const set = (nextLevel) => onChange(levelToSensitivity(nextLevel));
  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[9rem_minmax(12rem,1fr)_7rem] sm:items-center">
      <div>
        <div className="text-sm font-medium">{t("deviceDetail.fineTune.sensitivity")}</div>
        <div className="text-[11px] leading-4 text-muted-foreground">
          {explanation || t("deviceDetail.fineTune.sensitivityExplanation")}
        </div>
      </div>
      <div>
        <input type="range" min={1} max={COUNT_SENSITIVITY_LEVELS} step={1}
          value={level} disabled={disabled}
          aria-label={t("deviceDetail.fineTune.sensitivity")}
          aria-valuetext={t("deviceDetail.fineTune.sensitivityValueText", { level: formatCountSensitivity(value), peak: minimumPeakEnergy })}
          onChange={(event) => set(event.target.value)}
          onPointerUp={(event) => onCommit(levelToSensitivity(event.currentTarget.value))}
          onKeyUp={(event) => onCommit(levelToSensitivity(event.currentTarget.value))}
          className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50" />
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{t("deviceDetail.fineTune.levelFewer")}</span>
          <span>{t("deviceDetail.fineTune.levelMore", { level: COUNT_SENSITIVITY_LEVELS })}</span>
        </div>
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
          {t("deviceDetail.fineTune.peakHint")}
        </p>
      </div>
      <div className="sm:text-right">
        <div className="font-mono text-sm font-semibold tabular-nums">
          {formatCountSensitivity(value)}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">{t("deviceDetail.fineTune.minPeak")}</div>
        <div className="font-mono text-sm font-semibold tabular-nums text-primary">≈ {minimumPeakEnergy}</div>
        <div className="text-[10px] leading-4 text-muted-foreground">{formatChanged(date, t, intlLocale)}</div>
      </div>
    </div>
  );
}

function SpeedRow({ label, explanation, value, autoValue, min, max, step,
  slowLabel, fastLabel, formatValue, date, disabled, onChange, onCommit }) {
  const t = useT();
  const { intlLocale } = useLocale();
  const effective = value == null ? autoValue : value;
  const level = durationToSpeedLevel(effective, min, max);
  const display = `${value == null ? t("deviceDetail.fineTune.autoPrefix") : ""}${formatValue(effective)}`;
  const set = (nextLevel) => onChange(speedLevelToDuration(nextLevel, min, max, step));
  const nudge = (direction) => {
    const next = speedLevelToDuration(level + direction, min, max, step);
    onChange(next); onCommit(next);
  };
  return (
    <div className="grid gap-3 py-3 sm:grid-cols-[11rem_minmax(12rem,1fr)_8rem] sm:items-center">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[11px] leading-4 text-muted-foreground">{explanation}</div>
      </div>
      <div>
        <input type="range" min={0} max={SPEED_LEVELS} step={1} value={level} disabled={disabled}
          onChange={(event) => set(event.target.value)}
          onPointerUp={(event) => onCommit(speedLevelToDuration(event.currentTarget.value, min, max, step))}
          onKeyUp={(event) => onCommit(speedLevelToDuration(event.currentTarget.value, min, max, step))}
          className="h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50" />
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
          <span>{slowLabel}</span><span>{fastLabel}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 sm:hidden">
          <button type="button" onClick={() => nudge(-1)} disabled={disabled}
            className="grid size-10 place-items-center rounded-lg border border-border bg-background active:bg-muted disabled:opacity-50"
            aria-label={t("deviceDetail.fineTune.decrease", { label })}><Minus className="size-4" /></button>
          <span className="font-mono text-sm font-semibold tabular-nums">{display}</span>
          <button type="button" onClick={() => nudge(1)} disabled={disabled}
            className="grid size-10 place-items-center rounded-lg border border-border bg-background active:bg-muted disabled:opacity-50"
            aria-label={t("deviceDetail.fineTune.increase", { label })}><Plus className="size-4" /></button>
        </div>
      </div>
      <div className="hidden sm:block sm:text-right">
        <div className="font-mono text-sm font-semibold tabular-nums">{display}</div>
        <button type="button" onClick={() => { onChange(null); onCommit(null); }}
          disabled={disabled || value == null}
          className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:no-underline disabled:opacity-60">
          {formatChanged(date, t, intlLocale)}
        </button>
      </div>
      <button type="button" onClick={() => { onChange(null); onCommit(null); }}
        disabled={disabled || value == null}
        className="text-left text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:no-underline disabled:opacity-60 sm:hidden">
        {formatChanged(date, t, intlLocale)} · {t("deviceDetail.fineTune.resetToAuto")}
      </button>
    </div>
  );
}

export default function CountingFineTune({
  value, onSave, onPreview, disabled = false, className = "", sensitivityExplanation,
}) {
  const t = useT();
  const { intlLocale } = useLocale();
  const source = useMemo(() => ({
    count_sensitivity: normalizeCountSensitivity(value?.count_sensitivity),
    count_bridge_ms: value?.count_bridge_ms == null ? null : Number(value.count_bridge_ms),
  }), [value?.count_sensitivity, value?.count_bridge_ms]);
  const [draft, setDraft] = useState(source);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(false);
  const bridgeDefault = DEFAULT_COUNT_BRIDGE_MS;
  const minimumPeakEnergy = useMemo(() => {
    // The stroke energy chart uses the 250 Hz telemetry scale, like
    // EnergyDetector::lastEnergy.
    const displayed = sensitivityToEnergyThreshold(
      draft.count_sensitivity, draft.count_bridge_ms, ENERGY_FS, ENERGY_TELEMETRY_FS,
    );
    return displayed.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }, [draft.count_sensitivity, draft.count_bridge_ms, intlLocale]);

  useEffect(() => setDraft(source), [source]);

  function change(field, next) {
    const updated = { ...draft, [field]: next };
    setDraft(updated); onPreview?.(updated);
  }

  async function commit(field, next) {
    if (next === source[field] || saving) return;
    setSaving(field); setError(false);
    try {
      const result = await onSave?.({ [field]: next });
      if (result) {
        const updated = { ...draft, ...result };
        setDraft(updated); onPreview?.(updated);
      }
    } catch {
      setDraft(source); onPreview?.(source); setError(true);
    } finally { setSaving(null); }
  }

  async function resetAll() {
    if (saving) return;
    const reset = { count_sensitivity: DEFAULT_COUNT_SENSITIVITY_BP, count_bridge_ms: null };
    setDraft(reset); onPreview?.(reset); setSaving("all"); setError(false);
    try {
      const result = await onSave?.(reset);
      if (result) { setDraft({ ...reset, ...result }); onPreview?.({ ...reset, ...result }); }
    } catch {
      setDraft(source); onPreview?.(source); setError(true);
    } finally { setSaving(null); }
  }

  const changed = draft.count_sensitivity !== DEFAULT_COUNT_SENSITIVITY_BP || draft.count_bridge_ms != null;

  return (
    <div className={className}>
      <div className="divide-y divide-border/60">
        <SpeedRow label={t("deviceDetail.fineTune.strokePeriod")}
          explanation={t("deviceDetail.fineTune.strokePeriodExplanation")}
          value={draft.count_bridge_ms} autoValue={bridgeDefault} min={400} max={6000} step={25}
          slowLabel={t("deviceDetail.fineTune.slowCadence")} fastLabel={t("deviceDetail.fineTune.fastCadence")}
          formatValue={formatRate}
          date={value?.count_bridge_changed_at} disabled={disabled || !!saving}
          onChange={(v) => change("count_bridge_ms", v)}
          onCommit={(v) => commit("count_bridge_ms", v)} />
      </div>

      <StrokeMachinePreview
        sensitivity={normalizeCountSensitivity(draft.count_sensitivity)}
        minimumPeakEnergy={minimumPeakEnergy}
        bridgeMs={draft.count_bridge_ms == null ? bridgeDefault : draft.count_bridge_ms}
      />

      <MainSensitivity value={normalizeCountSensitivity(draft.count_sensitivity)}
        minimumPeakEnergy={minimumPeakEnergy}
        date={value?.count_sensitivity_changed_at} disabled={disabled || !!saving}
        explanation={sensitivityExplanation}
        onChange={(v) => change("count_sensitivity", v)}
        onCommit={(v) => commit("count_sensitivity", v)} />

      <div className="flex items-center justify-between gap-3 border-t border-border/60 py-3">
        <p className="text-[11px] leading-4 text-muted-foreground">
          {t("deviceDetail.fineTune.defaultHint")}
        </p>
        <button type="button" onClick={resetAll} disabled={disabled || !!saving || !changed}
          className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50">
          <RotateCcw className="size-3.5" /> {t("deviceDetail.fineTune.resetAll")}
        </button>
      </div>
      {error && <p className="pb-2 text-xs text-destructive">{t("deviceDetail.fineTune.saveFailed")}</p>}
    </div>
  );
}
