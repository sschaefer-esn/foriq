import { getIntlLocale, translate } from "./i18n/index.js";

export const DEFAULT_COUNT_BRIDGE_MS = 1500;
export const USER_TIMING_FACTOR = 1.0;

export const MIN_COUNT_SENSITIVITY_BP = 1000;
export const MAX_COUNT_SENSITIVITY_BP = 9999;
export const DEFAULT_COUNT_SENSITIVITY_BP = 3594;
export const COUNT_SENSITIVITY_SLIDER_MAX = 1000;
export const COUNT_SENSITIVITY_LEVELS = 10;

export const ENERGY_AMIN_LO = 0.03;
export const ENERGY_AMIN_HI = 0.80;
// Sample rate of the on-device detector, and the 250 Hz scale its telemetry
// (EnergyDetector::lastEnergy, kTelemetryFs) keeps for compatibility.
export const ENERGY_FS = 800;
export const ENERGY_TELEMETRY_FS = 250;

export function normalizeCountSensitivity(value) {
  const raw = Math.round(Number(value));
  if (raw >= MIN_COUNT_SENSITIVITY_BP && raw <= MAX_COUNT_SENSITIVITY_BP) return raw;
  if (raw === 0) return DEFAULT_COUNT_SENSITIVITY_BP;
  if (raw >= -40 && raw <= 40) {
    const baseLogit = Math.log(0.7 / 0.3);
    const cutoff = 1 / (1 + Math.exp(-(baseLogit - raw * Math.log(2) / 20)));
    return Math.max(MIN_COUNT_SENSITIVITY_BP,
      Math.min(MAX_COUNT_SENSITIVITY_BP, Math.round(cutoff * 10000)));
  }
  return DEFAULT_COUNT_SENSITIVITY_BP;
}

// Left is the strictest cutoff (counts fewer), right the lowest.
export function sensitivityToSlider(value) {
  const sensitivity = normalizeCountSensitivity(value);
  const fraction = Math.log(sensitivity / MIN_COUNT_SENSITIVITY_BP)
    / Math.log(MAX_COUNT_SENSITIVITY_BP / MIN_COUNT_SENSITIVITY_BP);
  return Math.round(COUNT_SENSITIVITY_SLIDER_MAX * (1 - fraction));
}

export function sliderToSensitivity(level) {
  const slider = Math.max(0, Math.min(COUNT_SENSITIVITY_SLIDER_MAX, Number(level)));
  const fraction = 1 - slider / COUNT_SENSITIVITY_SLIDER_MAX;
  return Math.round(MIN_COUNT_SENSITIVITY_BP
    * Math.pow(MAX_COUNT_SENSITIVITY_BP / MIN_COUNT_SENSITIVITY_BP, fraction));
}

export function sensitivityToLevel(value) {
  const slider = sensitivityToSlider(value);
  return 1 + Math.round((slider / COUNT_SENSITIVITY_SLIDER_MAX)
    * (COUNT_SENSITIVITY_LEVELS - 1));
}

export function levelToSensitivity(level) {
  const normalized = Math.max(1, Math.min(COUNT_SENSITIVITY_LEVELS, Math.round(Number(level))));
  const slider = ((normalized - 1) / (COUNT_SENSITIVITY_LEVELS - 1))
    * COUNT_SENSITIVITY_SLIDER_MAX;
  return sliderToSensitivity(slider);
}

export function sensitivityToAmin(value) {
  const bp = normalizeCountSensitivity(value);
  const span = MAX_COUNT_SENSITIVITY_BP - MIN_COUNT_SENSITIVITY_BP;
  const frac = Math.max(0, Math.min(1, (bp - MIN_COUNT_SENSITIVITY_BP) / span));
  return ENERGY_AMIN_LO * Math.pow(ENERGY_AMIN_HI / ENERGY_AMIN_LO, frac);
}

// Same reference movement and rounding as EnergyDetector::referenceEnergy.
// displayFs=ENERGY_TELEMETRY_FS converts to the telemetry scale like EnergyDetector::lastEnergy;
// without displayFs the threshold stays on the native scale of the recordings.
export function sensitivityToEnergyThreshold(value, bridgeMs = DEFAULT_COUNT_BRIDGE_MS, fs = ENERGY_FS, displayFs = fs) {
  const rawPeriod = Number(bridgeMs ?? DEFAULT_COUNT_BRIDGE_MS);
  const periodMs = Math.max(400, Math.min(6000,
    Number.isFinite(rawPeriod) && rawPeriod >= 0 ? rawPeriod : DEFAULT_COUNT_BRIDGE_MS));
  const windowMs = Math.max(20, periodMs / 4);
  const pulseMs = periodMs / 3;
  const dtMs = 1000 / fs;
  const count = Math.max(8, Math.floor(Math.max(4000, 8 * Math.max(windowMs, pulseMs)) / dtMs));
  const center = Math.floor(count / 2);
  const half = Math.max(1, Math.round((pulseMs / dtMs) / 2));
  const window = Math.max(1, Math.round(windowMs / dtMs));
  const skip = Math.floor(count / 5);
  const canonicalEnergy = (index) => {
    const u = (index - center) / half;
    const deviation = Math.abs(u) >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * u));
    return deviation * deviation;
  };
  let sum = 0;
  let maxSum = 0;
  for (let index = 0; index < count; index += 1) {
    sum += canonicalEnergy(index);
    if (index >= window) sum -= canonicalEnergy(index - window);
    sum = Math.max(0, sum);
    if (index >= skip) maxSum = Math.max(maxSum, sum);
  }
  const reference = maxSum > 1e-12 ? Math.sqrt(maxSum) : Math.sqrt(window * 0.25);
  return sensitivityToAmin(value) * reference * Math.sqrt(displayFs / fs);
}

export function formatAmin(value) {
  const amin = sensitivityToAmin(value).toLocaleString(getIntlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amin} g`;
}

export function formatCountSensitivity(value) {
  return translate("common.sensitivityLevel", {
    level: sensitivityToLevel(value),
    total: COUNT_SENSITIVITY_LEVELS,
  });
}
