// Rhythm statistics derived from hit timestamps (no firmware fields needed)
// plus shared time-axis formatting for the hit analysis charts.

// Cadence, median interval and jitter (coefficient of variation of the
// intervals) over an ascending timestamp list. All null with too little data.
export function rhythmStats(timestamps) {
  if (!timestamps || timestamps.length < 2) {
    return { count: timestamps?.length || 0, cadencePerMin: null, medianIntervalMs: null, jitterPct: null };
  }
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(timestamps[i] - timestamps[i - 1]);
  }
  const spanMs = timestamps[timestamps.length - 1] - timestamps[0];
  const cadencePerMin = spanMs > 0 ? (intervals.length / spanMs) * 60000 : null;

  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianIntervalMs =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  let jitterPct = null;
  if (mean > 0) {
    const variance =
      intervals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / intervals.length;
    jitterPct = (Math.sqrt(variance) / mean) * 100;
  }

  return { count: timestamps.length, cadencePerMin, medianIntervalMs, jitterPct };
}

// ── Rhythm / group detection ────────────────────────────────────────────
// Detects a machine's burst pattern from hit timestamps (e.g. "always 3
// strokes, then a pause") and flags incomplete groups (a missed or double-
// counted stroke). Derived purely from timestamps – no firmware/backend fields
// needed. Works ADAPTIVELY: the expected group size is learned locally from the
// neighbourhood, so a lasting rhythm change (3→5) is no false alarm while a
// single outlier group still is.

const RHYTHM_MIN_HITS = 6; // below this no reliable statement
const RHYTHM_SEPARATION_MIN = 1.8; // long/short gap ratio for a "burst"
const RHYTHM_IDLE_RATIO = 8; // upper cluster this far away = machine stoppage
const RHYTHM_IDLE_MAXFRAC = 0.2; // … and this rare = stoppage (not inter-burst)

// Compact 1D 2-means (Lloyd).
// Returns the two cluster centres in ascending order, or null.
function kmeans2_1d(values, iters = 25) {
  if (!values || values.length < 2) return null;
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) return null;
  for (let it = 0; it < iters; it++) {
    let sLo = 0, nLo = 0, sHi = 0, nHi = 0;
    for (const v of values) {
      if (Math.abs(v - lo) <= Math.abs(v - hi)) {
        sLo += v; nLo++;
      } else {
        sHi += v; nHi++;
      }
    }
    if (nLo === 0 || nHi === 0) break; // degenerate – keep the initial values
    const nLoC = sLo / nLo;
    const nHiC = sHi / nHi;
    if (nLoC === lo && nHiC === hi) break;
    lo = nLoC; hi = nHiC;
  }
  return lo <= hi ? [lo, hi] : [hi, lo];
}

// Threshold (ms) between intra- and inter-burst gaps from the log intervals.
// Iteratively peels off a small, very distant upper cluster (machine stoppage
// between production runs) and keeps clustering on the operating scale –
// otherwise 2-means would split "running vs. paused" instead of "within vs.
// between bursts" and see whole runs as one group. Null = no bursts.
function bundleThreshold(logs) {
  let work = logs;
  for (let peel = 0; peel < 3; peel++) {
    const centers = kmeans2_1d(work);
    if (!centers) return null;
    const [cLo, cHi] = centers;
    const boundary = (cLo + cHi) / 2;
    const ratio = Math.exp(cHi - cLo);
    let nHi = 0;
    for (const v of work) if (v > boundary) nHi++;
    const fHi = nHi / work.length;
    // Small AND far away = stoppage → split off, keep searching below.
    if (fHi <= RHYTHM_IDLE_MAXFRAC && ratio > RHYTHM_IDLE_RATIO) {
      const lo = work.filter((v) => v <= boundary);
      if (lo.length < RHYTHM_MIN_HITS - 1) return null;
      work = lo;
      continue;
    }
    // Otherwise: intra/inter-burst split (or unimodal = no bursts).
    if (ratio < RHYTHM_SEPARATION_MIN) return null;
    return Math.exp(boundary);
  }
  return null;
}

// Most frequent number in a list plus its share. On a tie: no clear mode.
function dominantMode(nums) {
  if (!nums.length) return { mode: null, fraction: 0 };
  const counts = new Map();
  for (const v of nums) counts.set(v, (counts.get(v) || 0) + 1);
  let mode = null, best = 0, tie = false;
  for (const [v, c] of counts) {
    if (c > best) { best = c; mode = v; tie = false; }
    else if (c === best) tie = true;
  }
  return { mode: tie ? null : mode, fraction: best / nums.length };
}

// Group detection over ascending timestamps (ms). Bundles strokes into bursts
// (short gap = within a burst, long gap = between bursts) and returns only the
// stroke count per group – NO rating, no target cadence.
// With rangeStart/rangeEnd only groups lying fully inside the analysis window
// are evaluated. If a context hit outside a window edge is missing, the edge
// group there is discarded as possibly cut off.
// Returns: { groups: [{ startTs, endTs, tsList, size }], confident }
export function detectRhythmGroups(timestamps, { rangeStart = null, rangeEnd = null } = {}) {
  const empty = { groups: [], confident: false };
  if (!timestamps || timestamps.length < RHYTHM_MIN_HITS) return empty;

  // Cluster intervals in log space (short = within a burst, long = pause).
  const intervals = [];
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push(Math.max(1, timestamps[i] - timestamps[i - 1]));
  }
  const logs = intervals.map((d) => Math.log(d));
  const threshold = bundleThreshold(logs); // short/long boundary (ms) | null
  if (threshold == null) return empty;

  // Cut groups at every long pause.
  const groups = [];
  let cur = [timestamps[0]];
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] - timestamps[i - 1] > threshold) {
      groups.push(cur);
      cur = [];
    }
    cur.push(timestamps[i]);
  }
  groups.push(cur);

  const allGroups = groups.map((tsList) => ({
    startTs: tsList[0],
    endTs: tsList[tsList.length - 1],
    tsList,
    size: tsList.length,
  }));
  const hasRangeStart = Number.isFinite(rangeStart);
  const hasRangeEnd = Number.isFinite(rangeEnd);
  let analyzedGroups = allGroups.filter((group) => (
    (!hasRangeStart || group.startTs > rangeStart)
    && (!hasRangeEnd || group.endTs <= rangeEnd)
  ));

  if (hasRangeStart && timestamps[0] >= rangeStart) {
    analyzedGroups = analyzedGroups.filter((group) => group !== allGroups[0]);
  }
  if (hasRangeEnd && timestamps[timestamps.length - 1] <= rangeEnd) {
    analyzedGroups = analyzedGroups.filter((group) => group !== allGroups.at(-1));
  }

  const sizes = analyzedGroups.map((group) => group.size);
  // Single strokes (typical group = 1 stroke) are no burst → do not group.
  const { mode, fraction } = dominantMode(sizes);
  if (analyzedGroups.length < 3 || mode == null || mode < 2 || fraction < 0.6) return empty;

  return {
    groups: analyzedGroups,
    confident: true,
  };
}
