# Playbook: fit stroke counting to a user's machines

For coding agents (Claude Code, Codex, …) working in this repository on behalf of a
Foriq user. Goal: the counts in Foriq match the strokes the user cares about. Work in
this order and stop at the first level that solves the problem:

1. **Interview** – understand the machine and what "one stroke" means.
2. **Settings** – most problems are solved by the two per-sensor settings, no code.
3. **Evidence** – measure with the stored stroke data before changing anything.
4. **Firmware change** – only when settings provably cannot work.

Talk to the user in their language, explain without jargon, one question block at a
time. Never change data or firmware on a live installation without their go-ahead.

## How counting works today

One counting path, on the sensor: `firmware-cpp/src/energy_detector.cpp`
(spec: [device-protocol.md › Stroke detection](../device-protocol.md#stroke-detection-firmware)).

- Input: magnitude of acceleration `g = sqrt(x²+y²+z²)` in g, 800 Hz (BMI270 FIFO).
  At rest `g ≈ 1`, independent of how the sensor is mounted.
- Activity `S = sqrt(Σ (g − 1)²)` over a sliding window `w = max(20 ms, T/4)`: a
  windowed RMS of the deviation from 1 g, i.e. essentially the standard deviation of
  the vibration within the window.
- `T` = **stroke period** (`count_bridge_ms`, 400–6000 ms, default 1500 ms = 40/min).
- `A_min` = **sensitivity** (`count_sensitivity`, 1000–9999 basis points, default 3594)
  mapped logarithmically to a minimum amplitude 0.03 … 0.80 g. Higher = counts less.
- Threshold `θ = A_min · R(T)`, `R(T)` = activity of a 1 g half-sine pulse lasting `T/3`.
- A stroke starts when `S > θ` and is counted once `T/2` has passed since its activity
  peak **and** `S` has dropped below `θ` again. Ringing inside that time is ignored.
- Each counted stroke is uploaded with `energy` (peak `S`, 250 Hz scale), `gforce`
  (peak-to-peak g) and `duration_ms`, stored in `device_hits`.

Consequences worth explaining to the user:

- `T` is a **dead time**, not a filter: two real strokes closer than about `T/2` merge
  into one; a single stroke whose vibration lasts longer than `T/2` above the threshold
  still counts once, but a second burst after `T/2` (e.g. a die bouncing, an ejector,
  the return stroke) counts again.
- Sensitivity only scales the threshold. Anything that shakes the machine harder than
  the threshold counts: crane, neighbouring hammer, forklift, idle flywheel.

## 1. Interview

Ask until you can answer every point; skip what the user already said.

**Machine and process**
- Machine type and model (eccentric/crank press, hydraulic press, screw press, drop
  hammer, punching machine, injection moulding, packaging machine, …).
- What should be counted: every ram stroke, every part, every cycle? Several blows per
  part (hammer, progressive forging)? Should those be one count or several?
- Stroke rate: typical and fastest strokes per minute; single strokes or continuous run;
  pauses between parts.
- What the machine does when not producing: motor/flywheel running idle, hydraulics
  pumping, clutch disengaged, setup jogging. Should any of that count? (It must not.)
- Any second movement per cycle: return stroke, ejector, transfer, feeder, die cushion.

**Environment and mounting**
- Where the sensor sits (frame, ram, table, guard) and how (magnet, screw, cable tie).
  The best spot moves rigidly with the stroke impact and little else.
- Other vibration sources nearby: other machines on the same foundation, cranes,
  forklifts, compressors.

**Ground truth and target**
- Is there a reference counter (machine controller, mechanical counter, parts count
  from a shift)? Without one, tuning is guesswork – ask the user to count 50–100
  strokes by hand or note the controller counter before and after a run.
- Which error is acceptable (e.g. ±1 %), and which is worse: missed or extra strokes?

## 2. Settings (no code)

In the web UI: device detail › *Feineinstellung / Fine-tune*: *Hubperiode T / Stroke
period* and *Empfindlichkeit / Sensitivity*; the chart *Schlagenergie / Stroke energy*
shows each counted stroke's energy. Through the API: `PUT /api/v1/devices/{id}` with
`count_bridge_ms` and `count_sensitivity` (owner/admin login). The sensor applies new
settings within seconds.

1. Set `T` to the **shortest real interval between two strokes** (60000 / max strokes
   per minute), rounded down by ~10 %. Too long merges fast strokes; too short lets a
   second burst of the same stroke count.
2. Then sensitivity: counts too many → stricter (higher); misses strokes → more
   sensitive (lower). Compare with the energy chart: the threshold should sit clearly
   between the energy of real strokes and the energy of the "noise" events.
3. Run a reference count after each change, one change at a time.

Typical starting points (verify, do not trust):

| Machine | T | Sensitivity |
|---|---|---|
| Fast eccentric press, 60–120/min | 400–900 ms | default, stricter if the idle flywheel counts |
| Drop/air hammer, single blows | 600–1500 ms | stricter (blows are strong) |
| Hammer, several blows per part, count parts | longer than one part's blow sequence | default |
| Hydraulic press, slow | 2000–6000 ms | more sensitive (soft impact) |

## 3. Evidence from the stored data

Run read-only SQL against the database (development: `./dev.sh app` uses the installed
app's DB; connection details in `dev.sh`). Never write to a live database.

```sql
-- one sensor: id, settings
SELECT id, name, count_bridge_ms, count_sensitivity FROM devices ORDER BY name;

-- strokes of the last hour with the gap to the previous one
SELECT recorded_at, energy, gforce, hit_duration_ms,
       EXTRACT(EPOCH FROM recorded_at - LAG(recorded_at) OVER (ORDER BY recorded_at)) * 1000 AS gap_ms
FROM device_hits
WHERE device_id = :id AND counted AND recorded_at > NOW() - INTERVAL '1 hour'
ORDER BY recorded_at;

-- energy distribution: two clusters = real strokes vs. noise
SELECT width_bucket(energy, 0, 50, 25) AS bucket, COUNT(*), MIN(energy), MAX(energy)
FROM device_hits WHERE device_id = :id AND counted AND recorded_at > NOW() - INTERVAL '1 day'
GROUP BY 1 ORDER BY 1;
```

How to read it:

- **Double counts:** pairs with `gap_ms` well below the real stroke interval, often the
  second one with lower energy → `T` too short, or a second movement per cycle.
- **Merged strokes:** count too low at high rates and gaps cluster at multiples of the
  real interval → `T` too long.
- **Noise counts:** low-energy events while the machine does not produce (check against
  shift times) → stricter sensitivity, better mounting spot.
- **Missed strokes:** count too low at normal rates, real strokes' energy close to the
  threshold → more sensitive.

Recorded values are only the counted strokes; what stayed below the threshold is not
stored. If that matters, use a temporary capture build (below).

## 4. Changing the algorithm (firmware)

Only when the evidence shows that no combination of `T` and sensitivity works, e.g.
the noise is as strong as the strokes, or one cycle has two equally strong impacts that
must count once but are further apart than the fastest stroke interval.

Rules:

- Keep one counting path in `energy_detector.cpp`; keep `pushNative()` / `setOp()` /
  `noteWallGap()` as the interface used by `main.cpp`.
- Prefer adding a parameter that defaults to today's behaviour. New per-sensor settings
  travel like `count_bridge_ms`: DB column in `webapp/sql/schema.sql` (idempotent `DO`
  block), `devices.py` (model, validation, select), `settings.py` (sync response),
  `api_client.cpp` (apply), frontend settings and both i18n dictionaries.
- Extend `firmware-cpp/test/test_energy_detector.cpp` with a synthetic signal that
  reproduces the user's problem first, then fix it; the test must pass
  (command in [firmware.md › Unit test](../firmware.md#unit-test)).
- Bump `firmware-cpp/VERSION` (MINOR for a new behaviour), build with
  `pio run -e m5sticks3` (size check included), put it into service with
  `./build-app.sh` (sensors with auto-update fetch it), update the "Stroke detection" section of
  `docs/device-protocol.md` and `CHANGELOG.md`.
- Ideas that fit the existing structure: band-pass/high-pass before squaring (removes
  slow tilt or very high-frequency hum), a minimum active duration, a second threshold
  for closing an episode (hysteresis), using one axis instead of the magnitude when the
  stroke direction is known.

**Capturing raw signals.** For hard cases build a temporary debug image (`-DFORIQ_DEBUG=1`,
see `firmware-cpp/include/config.h`) that prints the magnitudes or `S` over USB serial,
record a few minutes of production and idle, and replay the recording through the host
test harness. Note: opening the serial port of the M5Stick S3 resets it and can leave it
in download mode ([README › Firmware](../../README.md#firmware-firmware-cpp-m5stick-s3)).
Never ship a debug build.

## Done when

- The user confirmed the reference count matches within their tolerance.
- Settings per sensor are noted for the user (and, if code changed, tests pass, VERSION
  is bumped, docs and changelog updated).
