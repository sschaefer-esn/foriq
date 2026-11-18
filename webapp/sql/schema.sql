-- Foriq – database schema
-- Idempotent and rollout-safe: can be run any number of times.

-- Companies/tenants
CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Users (no company_id/role – handled via memberships)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Memberships: user ↔ company (n:m) with role
CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'viewer',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, company_id)
);

-- Migration: old columns → memberships (if still present)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'company_id'
    ) THEN
        INSERT INTO memberships (user_id, company_id, role)
        SELECT id, company_id, role FROM users WHERE company_id IS NOT NULL
        ON CONFLICT DO NOTHING;

        ALTER TABLE users DROP COLUMN company_id;
        ALTER TABLE users DROP COLUMN role;
        DROP INDEX IF EXISTS idx_users_company;
    END IF;
END $$;

-- Devices
CREATE TABLE IF NOT EXISTS devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
    -- Without the optional HMAC key this compatible plaintext column is used;
    -- with a key the token lives exclusively in device_token_hash.
    device_token VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    serial_number VARCHAR(100) UNIQUE NOT NULL,
    last_seen_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_company ON devices(company_id);

-- Phase 4 (English names): rename German device columns without data loss.
-- Runs before all later ADD COLUMN migrations so they never recreate the old
-- names. Only if the old column exists and the new one does not yet; every
-- further run is a no-op.
DO $$
DECLARE
    pair RECORD;
BEGIN
    FOR pair IN
        SELECT * FROM (VALUES
            ('uebertragung_intervall_s', 'upload_interval_s'),
            ('sleep_nach_min',           'sleep_after_min'),
            ('neustart_plan',            'restart_schedule'),
            ('schlag_schwelle',          'stroke_threshold')
        ) AS t(old_name, new_name)
    LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'devices' AND column_name = pair.old_name
        ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'devices' AND column_name = pair.new_name
        ) THEN
            EXECUTE format('ALTER TABLE devices RENAME COLUMN %I TO %I',
                           pair.old_name, pair.new_name);
        END IF;
    END LOOP;
END $$;

-- Measurement data (the core)
CREATE TABLE IF NOT EXISTS device_hits (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
    gforce FLOAT NOT NULL,
    recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Note: the indexes on device_hits are at the end of the file, after the
-- partitioning (which recreates the table). The old plain
-- (device_id, recorded_at) index is replaced there by the covering index
-- (device_id, recorded_at, gforce).
DROP INDEX IF EXISTS idx_device_hits_recorded;

-- The external API is an optional add-on, enabled server-side.
-- It is off in the standard product; keys are provisioned internally only.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS external_api_enabled BOOLEAN NOT NULL DEFAULT false;

-- API keys for external systems (ERP integration): company-wide, read-only.
-- The full key is only shown at creation. Only
-- HMAC-SHA256(API_KEY_HMAC_KEY, key) is persisted.
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(12) NOT NULL,
    key_hash VARCHAR(64),
    key_plain TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    last_used_at TIMESTAMP,
    revoked_at TIMESTAMP
);

-- Two-phase migration for existing plaintext keys: prepare adds the hash
-- and keeps key_plain for an app rollback; finalize clears it only after sign-off.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash VARCHAR(64);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_plain TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id);
DROP INDEX IF EXISTS idx_api_keys_plain;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE key_hash IS NOT NULL;

-- Fine-grained sensor access and shifts are no longer used by the new
-- product. Existing tables are kept for now (data is not dropped
-- automatically); a later release may remove them.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'firmware_version'
    ) THEN
        ALTER TABLE devices ADD COLUMN firmware_version VARCHAR(20);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'auto_update'
    ) THEN
        ALTER TABLE devices ADD COLUMN auto_update BOOLEAN DEFAULT true;
    END IF;
    -- Factory default for new setups: auto-update on (also for existing schemas)
    EXECUTE 'ALTER TABLE devices ALTER COLUMN auto_update SET DEFAULT true';
    -- firmware_target selects the OTA channel (build target). Only 'm5sticks3'
    -- is served; rows of retired hardware keep their stored value and get no OTA.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'firmware_target'
    ) THEN
        ALTER TABLE devices ADD COLUMN firmware_target TEXT DEFAULT 'm5sticks3';
    END IF;
    -- New devices are S3 sensors (existing rows are left unchanged).
    EXECUTE 'ALTER TABLE devices ALTER COLUMN firmware_target SET DEFAULT ''m5sticks3''';
END $$;

-- Command queue for devices
CREATE TABLE IF NOT EXISTS device_commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    command VARCHAR(50) NOT NULL,
    payload JSONB DEFAULT '{}',
    status VARCHAR(20) DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT NOW(),
    delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_commands_device_status
    ON device_commands(device_id, status);

-- Migration: add progress + completed_at to device_commands
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'device_commands' AND column_name = 'progress'
    ) THEN
        ALTER TABLE device_commands ADD COLUMN progress VARCHAR(50);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'device_commands' AND column_name = 'completed_at'
    ) THEN
        ALTER TABLE device_commands ADD COLUMN completed_at TIMESTAMP;
    END IF;
END $$;

-- Migration: add upload_interval_s to devices
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'upload_interval_s'
    ) THEN
        ALTER TABLE devices ADD COLUMN upload_interval_s INTEGER DEFAULT 0;
    END IF;
END $$;

-- Migration: add restart_schedule to devices
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'restart_schedule'
    ) THEN
        ALTER TABLE devices ADD COLUMN restart_schedule JSONB DEFAULT NULL;
    END IF;
END $$;

-- Configurable downtime/offline alerts per sensor. weekly_windows:
-- [{"days":[1,2,3,4,5],"start":"08:00","end":"10:00"}]
CREATE TABLE IF NOT EXISTS device_notification_rules (
    device_id UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT false,
    threshold_minutes INTEGER NOT NULL DEFAULT 10 CHECK (threshold_minutes BETWEEN 1 AND 1440),
    require_work_phase BOOLEAN NOT NULL DEFAULT false,
    minimum_work_minutes INTEGER NOT NULL DEFAULT 5 CHECK (minimum_work_minutes BETWEEN 1 AND 1440),
    notify_activity_resumed BOOLEAN NOT NULL DEFAULT true,
    notify_device_offline BOOLEAN NOT NULL DEFAULT false,
    weekly_windows JSONB NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE device_notification_rules
    ADD COLUMN IF NOT EXISTS notify_device_offline BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE device_notification_rules
    ADD COLUMN IF NOT EXISTS require_work_phase BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE device_notification_rules
    ADD COLUMN IF NOT EXISTS minimum_work_minutes INTEGER NOT NULL DEFAULT 5
        CHECK (minimum_work_minutes BETWEEN 1 AND 1440);
ALTER TABLE device_notification_rules
    ADD COLUMN IF NOT EXISTS notify_activity_resumed BOOLEAN NOT NULL DEFAULT true;

-- Named, company-wide rule groups. A machine may deliberately belong to only one
-- group so overlapping schedules cannot produce duplicate alerts.
CREATE TABLE IF NOT EXISTS notification_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    threshold_minutes INTEGER NOT NULL DEFAULT 10 CHECK (threshold_minutes BETWEEN 1 AND 1440),
    require_work_phase BOOLEAN NOT NULL DEFAULT false,
    minimum_work_minutes INTEGER NOT NULL DEFAULT 5 CHECK (minimum_work_minutes BETWEEN 1 AND 1440),
    notify_activity_resumed BOOLEAN NOT NULL DEFAULT true,
    notify_device_offline BOOLEAN NOT NULL DEFAULT false,
    weekly_windows JSONB NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
ALTER TABLE notification_rules
    ADD COLUMN IF NOT EXISTS notify_device_offline BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE notification_rules
    ADD COLUMN IF NOT EXISTS require_work_phase BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE notification_rules
    ADD COLUMN IF NOT EXISTS minimum_work_minutes INTEGER NOT NULL DEFAULT 5
        CHECK (minimum_work_minutes BETWEEN 1 AND 1440);
ALTER TABLE notification_rules
    ADD COLUMN IF NOT EXISTS notify_activity_resumed BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_notification_rules_company
    ON notification_rules(company_id, created_at);

CREATE TABLE IF NOT EXISTS notification_rule_devices (
    rule_id UUID NOT NULL REFERENCES notification_rules(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    no_hits_notification_sent BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rule_id, device_id)
);
ALTER TABLE notification_rule_devices
    ADD COLUMN IF NOT EXISTS no_hits_notification_sent BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_rule_devices_device
    ON notification_rule_devices(device_id);

-- The migration marker is declared again idempotently further below. It must
-- already exist here so old 1:1 device rules are converted into named
-- single-device groups exactly once and deleted rules are not accidentally
-- resurrected by a later schema run.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
);

DO $$
DECLARE
    legacy RECORD;
    migrated_rule_id UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM schema_migrations
        WHERE name = 'v14_notification_rule_sets'
    ) THEN
        FOR legacy IN
            SELECT old.device_id, old.enabled, old.threshold_minutes,
                   old.require_work_phase, old.minimum_work_minutes,
                   old.notify_activity_resumed,
                   old.notify_device_offline,
                   old.weekly_windows, old.revision, old.updated_at,
                   old.updated_by, d.company_id, d.name AS device_name
            FROM device_notification_rules old
            JOIN devices d ON d.id = old.device_id
            WHERE NOT EXISTS (
                SELECT 1 FROM notification_rule_devices rd
                WHERE rd.device_id = old.device_id
            )
        LOOP
            INSERT INTO notification_rules (
                company_id, name, enabled, threshold_minutes,
                require_work_phase, minimum_work_minutes, notify_activity_resumed,
                notify_device_offline, weekly_windows,
                revision, created_at, updated_at, updated_by
            ) VALUES (
                legacy.company_id,
                COALESCE(NULLIF(BTRIM(legacy.device_name), ''), 'Maschine') || ' – Stillstand',
                legacy.enabled, legacy.threshold_minutes,
                legacy.require_work_phase, legacy.minimum_work_minutes,
                legacy.notify_activity_resumed,
                legacy.notify_device_offline, legacy.weekly_windows,
                legacy.revision, legacy.updated_at, legacy.updated_at,
                legacy.updated_by
            ) RETURNING id INTO migrated_rule_id;

            INSERT INTO notification_rule_devices (rule_id, device_id)
            VALUES (migrated_rule_id, legacy.device_id)
            ON CONFLICT (device_id) DO NOTHING;
        END LOOP;

        INSERT INTO schema_migrations (name)
        VALUES ('v14_notification_rule_sets');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS notification_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    rule_id UUID REFERENCES notification_rules(id) ON DELETE SET NULL,
    rule_name VARCHAR(255),
    rule_revision INTEGER NOT NULL,
    alert_type VARCHAR(30) NOT NULL CHECK (alert_type IN ('no_hits', 'device_offline')),
    window_start_at TIMESTAMP NOT NULL,
    window_end_at TIMESTAMP NOT NULL,
    condition_since_at TIMESTAMP NOT NULL,
    triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP,
    resolution VARCHAR(30),
    notify_activity_resumed BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE notification_incidents ADD COLUMN IF NOT EXISTS rule_id UUID;
ALTER TABLE notification_incidents ADD COLUMN IF NOT EXISTS rule_name VARCHAR(255);
ALTER TABLE notification_incidents
    ADD COLUMN IF NOT EXISTS notify_activity_resumed BOOLEAN NOT NULL DEFAULT true;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_incidents_rule_id_fkey'
          AND conrelid = 'notification_incidents'::regclass
    ) THEN
        ALTER TABLE notification_incidents
            ADD CONSTRAINT notification_incidents_rule_id_fkey
            FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Existing incidents get the rule assigned at rollout time as the best
-- possible snapshot; new incidents write ID and name atomically.
UPDATE notification_incidents i
SET rule_id = rd.rule_id,
    rule_name = r.name
FROM notification_rule_devices rd
JOIN notification_rules r ON r.id = rd.rule_id
WHERE i.device_id = rd.device_id
  AND i.rule_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_notification_incidents_company_recent
    ON notification_incidents(company_id, triggered_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_incident_open
    ON notification_incidents(device_id, alert_type)
    WHERE resolved_at IS NULL;

-- Read status is per user: a viewer must not remove an alert from the
-- notification center for all other company members.
CREATE TABLE IF NOT EXISTS notification_reads (
    incident_id UUID NOT NULL REFERENCES notification_incidents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (incident_id, user_id)
);

ALTER TABLE devices DROP COLUMN IF EXISTS ema_noise;
ALTER TABLE devices DROP COLUMN IF EXISTS ema_peak;
ALTER TABLE devices DROP COLUMN IF EXISTS ema_threshold;

-- Floor plans (machine arrangement)
CREATE TABLE IF NOT EXISTS layouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL DEFAULT 'Halle 1',
    grid_cols INTEGER NOT NULL DEFAULT 24,
    grid_rows INTEGER NOT NULL DEFAULT 16,
    items JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_layouts_company ON layouts(company_id);

-- The debug log subsystem is no longer used; its tables are kept for now
-- and may be removed in a later release.

-- Migration: add energy to device_hits
ALTER TABLE device_hits ADD COLUMN IF NOT EXISTS energy FLOAT;

-- Sleep mode
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sleep_mode BOOLEAN DEFAULT false;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sleep_after_min INTEGER DEFAULT 10;

-- Time zone per company (for daily counters in local time)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Europe/Berlin';

-- Marker table for one-off data migrations (idempotent).
CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE companies DROP COLUMN IF EXISTS data_collection_enabled;
ALTER TABLE companies DROP COLUMN IF EXISTS data_collection_intensive;

-- Old statistics/alert tables are not read by the new notification model
-- and are kept for now; a later release may remove them.
-- [REMOVED] BOCPD state (bocpd_state, bocpd_hazard_lambda, bocpd_cp_threshold) — no longer needed
-- [REMOVED] Detected regimes (device_regimes) — no longer needed

-- Temporary OTA compatibility value for firmware < 13.25. The current
-- backend and the energy firmware do not use it for inference.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stroke_threshold FLOAT DEFAULT 0.5;
-- Set the default to 0.5 (if the column already exists)
DO $$ BEGIN
    EXECUTE 'ALTER TABLE devices ALTER COLUMN stroke_threshold SET DEFAULT 0.5';
END $$;

-- Stroke duration (time above threshold) per hit
ALTER TABLE device_hits ADD COLUMN IF NOT EXISTS hit_duration_ms INTEGER;

-- Fast settings sync: time window for accelerated polling while the UI is active
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fast_sync_until TIMESTAMP DEFAULT NULL;

-- Temporary OTA compatibility value for firmware < 13.25.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS min_peak_g FLOAT DEFAULT 0;

-- Migration: g² → (g-1)² — reset old thresholds
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM devices WHERE stroke_threshold > 1.0
    ) THEN
        UPDATE devices SET stroke_threshold = 0.5 WHERE stroke_threshold > 1.0;
    END IF;
END $$;

-- Temporary OTA compatibility values, passed through unchanged, for firmware
-- < 13.25 still in the field. None of these columns is evaluated by the backend or
-- by the current energy firmware. Once the fleet rollout is complete they can
-- all be dropped together.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS std_window INTEGER DEFAULT 19;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS sensitivity_ms INTEGER DEFAULT 50;
ALTER TABLE devices ALTER COLUMN sensitivity_ms SET DEFAULT 50;
-- One-off migration of the old scale (1..10) -> new scale (1..100): ×10, keeping
-- the position (old level 5 = P 1.0 -> new level 50 = P 1.0). Guarded via a column
-- comment so re-runs do not multiply newly set values (≤10) by 10 again.
DO $$
BEGIN
    IF COALESCE(col_description('devices'::regclass,
            (SELECT attnum FROM pg_attribute
              WHERE attrelid = 'devices'::regclass AND attname = 'sensitivity_ms')), '')
        <> 'scale100' THEN
        UPDATE devices SET sensitivity_ms = sensitivity_ms * 10
         WHERE sensitivity_ms BETWEEN 1 AND 10;
        COMMENT ON COLUMN devices.sensitivity_ms IS 'scale100';
    END IF;
END $$;
-- Invalid values (NULL or outside 1..100) go to the default level 50.
UPDATE devices SET sensitivity_ms = 50
 WHERE sensitivity_ms IS NULL OR sensitivity_ms < 1 OR sensitivity_ms > 100;

-- Historical backfill formula, only to preserve existing values of old devices.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hysteresis_ms INTEGER;
UPDATE devices
   SET hysteresis_ms = LEAST(20000, GREATEST(0,
         ROUND(120 * power(10, 1.4 * (COALESCE(sensitivity_ms, 50) - 50) / 50.0))))::int
 WHERE hysteresis_ms IS NULL;
ALTER TABLE devices ALTER COLUMN hysteresis_ms SET DEFAULT 120;

-- Transport/Wi-Fi diagnostics. New firmware persists the counters monotonically in
-- NVS; old firmware reports them since boot.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_drop_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_spiffs_write_errors INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_server_rejected_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_last_upload_ms INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_max_upload_ms INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_http_error_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_queue_ram_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_queue_flash_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hit_queue_oldest_age_s INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_rssi INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_offline_s INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_reconnect_count INTEGER DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wifi_roam_count INTEGER DEFAULT 0;

-- ─── Strategy change v5.0 (May 2026) ──────────────────────────
-- High-performance mode becomes the new default: no CPU downscaling, no Wi-Fi
-- modem sleep, no sleep mode, polling raised to 500 Hz (on the firmware
-- side). power_save_mode per device re-enables the old measures
-- (for existing battery-powered devices).

ALTER TABLE devices ADD COLUMN IF NOT EXISTS power_save_mode BOOLEAN DEFAULT false;

-- Remove hit_cooldown_ms (replaced by k-means)
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='devices' AND column_name='hit_cooldown_ms') THEN
        ALTER TABLE devices DROP COLUMN hit_cooldown_ms;
    END IF;
END $$;

-- Change the sleep mode default: new devices start without sleep mode.
DO $$ BEGIN
    EXECUTE 'ALTER TABLE devices ALTER COLUMN sleep_after_min SET DEFAULT 0';
END $$;

-- Existing devices: disable sleep mode (once, via marker).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'v5_0_disable_sleep_for_existing') THEN
        UPDATE devices SET sleep_after_min = 0 WHERE sleep_after_min IS NOT NULL AND sleep_after_min > 0;
        INSERT INTO schema_migrations (name) VALUES ('v5_0_disable_sleep_for_existing');
    END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- OTA hardening: heartbeat timestamp, one-off cleanup, invariants
-- ════════════════════════════════════════════════════════════════════════

-- Heartbeat of a running OTA attempt. The reaper measures against it so a
-- slow but alive download is not reaped as a timeout.
ALTER TABLE device_commands ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMP;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'v13_3_ota_hardening') THEN
        -- (1) Heal zombie rows: /ota/progress set 'failed' but never
        --     completed_at. Without a timestamp the retry backoff does not apply.
        UPDATE device_commands
        SET completed_at = COALESCE(delivered_at, created_at)
        WHERE command = 'ota_update' AND status = 'failed' AND completed_at IS NULL;

        -- (2) Resolve duplicates — only the newest open row per device remains.
        --     MUST run before the unique index, otherwise creating it fails.
        UPDATE device_commands c
        SET status = 'failed', progress = 'superseded', completed_at = NOW()
        WHERE c.command = 'ota_update'
          AND c.status IN ('pending', 'delivered', 'in_progress')
          AND c.id <> (
              SELECT c2.id FROM device_commands c2
              WHERE c2.device_id = c.device_id AND c2.command = 'ota_update'
                AND c2.status IN ('pending', 'delivered', 'in_progress')
              ORDER BY c2.created_at DESC, c2.id DESC
              LIMIT 1
          );

        INSERT INTO schema_migrations (name) VALUES ('v13_3_ota_hardening');
    END IF;
END $$;

-- Invariant: at most ONE open ota_update command per device. Enforced by the DB
-- so that even two parallel syncs (read committed, no FOR UPDATE) cannot create
-- two rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_commands_open_ota
    ON device_commands (device_id)
    WHERE command = 'ota_update'
      AND status IN ('pending', 'delivered', 'in_progress');

-- Process-wide reaper: scans open OTA commands across all devices by age.
CREATE INDEX IF NOT EXISTS idx_device_commands_open_ota_age
    ON device_commands (COALESCE(last_progress_at, delivered_at, created_at))
    WHERE command = 'ota_update'
      AND status IN ('pending', 'delivered', 'in_progress');

-- Backoff derivation: failure history per device since the last success.
CREATE INDEX IF NOT EXISTS idx_device_commands_ota_history
    ON device_commands (device_id, status, completed_at)
    WHERE command = 'ota_update';

-- The former raw-sample mapping referenced device_hits. It has to go before
-- a first-time partitioning so the subsequent drop of the renamed old
-- table does not fail on its foreign key.
DROP TABLE IF EXISTS learning_hit_samples;

-- ════════════════════════════════════════════════════════════════════════
-- Partitioning of device_hits by recorded_at (monthly, RANGE)
-- Must run AFTER all device_hits column migrations. Idempotent:
-- only converts if the table is
-- not partitioned yet (relkind <> 'p').
-- ════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
    is_part boolean;
    min_m   date;
    end_m   date;
    m       date;
    max_id  bigint;
BEGIN
    SELECT (relkind = 'p') INTO is_part FROM pg_class WHERE relname = 'device_hits';
    IF is_part IS TRUE THEN
        RETURN;  -- already partitioned
    END IF;

    ALTER TABLE device_hits RENAME TO device_hits_old;
    -- Rename the PK constraint/index → no name collision with the new table
    ALTER TABLE device_hits_old RENAME CONSTRAINT device_hits_pkey TO device_hits_old_pkey;

    CREATE TABLE device_hits (
        id              bigint NOT NULL DEFAULT nextval('device_hits_id_seq'),
        device_id       uuid REFERENCES devices(id) ON DELETE CASCADE,
        gforce          double precision NOT NULL,
        recorded_at     timestamp NOT NULL DEFAULT NOW(),
        energy          double precision,
        hit_duration_ms integer,
        counted         boolean NOT NULL DEFAULT true,
        boot_id         bigint,
        event_sequence  bigint,
        PRIMARY KEY (id, recorded_at)
    ) PARTITION BY RANGE (recorded_at);

    ALTER SEQUENCE device_hits_id_seq OWNED BY device_hits.id;

    -- Monthly partitions from the oldest data month to 24 months ahead
    SELECT date_trunc('month', COALESCE(MIN(recorded_at), NOW()))::date INTO min_m FROM device_hits_old;
    end_m := (date_trunc('month', NOW()) + interval '24 months')::date;
    m := min_m;
    WHILE m < end_m LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS device_hits_p%s PARTITION OF device_hits FOR VALUES FROM (%L) TO (%L)',
            to_char(m, 'YYYYMM'), m::timestamp, (m + interval '1 month')::timestamp
        );
        m := (m + interval '1 month')::date;
    END LOOP;

    -- Safety net: everything outside the monthly partitions (inserts never fail)
    CREATE TABLE IF NOT EXISTS device_hits_pdefault PARTITION OF device_hits DEFAULT;

    -- Read optional columns via JSON: this keeps the conversion repeatable for
    -- older intermediate states and after a legacy cleanup has already run.
    -- The historical ``counted`` value is preserved so old diagnostic
    -- candidates never show up retroactively as customer strokes.
    INSERT INTO device_hits (
        id, device_id, gforce, recorded_at, energy,
        hit_duration_ms, counted,
        boot_id, event_sequence
    )
    SELECT
        old.id,
        old.device_id,
        old.gforce,
        old.recorded_at,
        NULLIF(payload.data->>'energy', '')::double precision,
        NULLIF(payload.data->>'hit_duration_ms', '')::integer,
        COALESCE((payload.data->>'counted')::boolean, true),
        NULLIF(payload.data->>'boot_id', '')::bigint,
        NULLIF(payload.data->>'event_sequence', '')::bigint
    FROM device_hits_old AS old
    CROSS JOIN LATERAL (SELECT to_jsonb(old) AS data) AS payload;

    SELECT COALESCE(MAX(id), 0) INTO max_id FROM device_hits;
    PERFORM setval('device_hits_id_seq', max_id + 1, false);

    DROP TABLE device_hits_old;
END $$;

-- Ensure monthly partitions for the coming months (self-maintaining on
-- every deploy/schema run). Keeps the spare partitions rolling so new
-- data never ends up permanently in the default partition.
DO $$
DECLARE
    m     date;
    end_m date;
BEGIN
    IF (SELECT relkind FROM pg_class WHERE relname = 'device_hits') <> 'p' THEN
        RETURN;
    END IF;
    m := date_trunc('month', NOW())::date;
    end_m := (date_trunc('month', NOW()) + interval '24 months')::date;
    WHILE m < end_m LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS device_hits_p%s PARTITION OF device_hits FOR VALUES FROM (%L) TO (%L)',
            to_char(m, 'YYYYMM'), m::timestamp, (m + interval '1 month')::timestamp
        );
        m := (m + interval '1 month')::date;
    END LOOP;
END $$;

-- Indexes on the (partitioned) device_hits table — inherited by all partitions.
-- They come last because partitioning recreates the table.
DROP INDEX IF EXISTS idx_device_hits_device_datum;
CREATE INDEX IF NOT EXISTS idx_device_hits_dev_rec_gforce ON device_hits(device_id, recorded_at, gforce);

-- The historical counting decision is kept as a data integrity attribute.
-- ``counted=false`` comes from old diagnostic uploads and must not count in any
-- product statistic. New energy hits always get the default true.
ALTER TABLE device_hits ADD COLUMN IF NOT EXISTS counted BOOLEAN NOT NULL DEFAULT TRUE;
CREATE INDEX IF NOT EXISTS idx_device_hits_counted_recent
    ON device_hits(device_id, recorded_at DESC) WHERE counted;

-- Minimum energy amplitude in basis points (1000..9999) → A_min log 0.03..0.80 g.
-- 1000 = smallest amplitude (counts more), 9999 = largest (counts less), 3594 = product default (level 5/10).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS count_sensitivity SMALLINT NOT NULL DEFAULT 3594;
ALTER TABLE devices ALTER COLUMN count_sensitivity SET DEFAULT 3594;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS count_sensitivity_changed_at TIMESTAMPTZ;
-- Move the previous default to level 5/10; deliberately only unchanged default values.
UPDATE devices SET count_sensitivity = 3594
WHERE count_sensitivity = 5000 AND count_sensitivity_changed_at IS NULL;
-- Move the previous 70 % default; deliberately only unchanged default values.
UPDATE devices SET count_sensitivity = 3594
WHERE count_sensitivity = 7000 AND count_sensitivity_changed_at IS NULL;
-- One-off, idempotent data migration of the historical -40..40 scale.
UPDATE devices
SET count_sensitivity_changed_at = CASE
        WHEN count_sensitivity = 0 THEN NULL ELSE count_sensitivity_changed_at END,
    count_sensitivity = CASE WHEN count_sensitivity = 0 THEN 3594 ELSE ROUND(
            10000.0 / (1.0 + EXP(-(
                LN(0.7 / 0.3) - count_sensitivity * LN(2.0) / 20.0
            )))
        )::SMALLINT END
WHERE count_sensitivity BETWEEN -40 AND 40;
-- Stroke period T in milliseconds (NULL = product default).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS count_bridge_ms INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS count_bridge_changed_at TIMESTAMPTZ;

-- Lean production counter per machine. Deliberately stored on the device rather than
-- as an order/ERP model: NULL when the counter is inactive, timestamp as the start
-- for the pieces detected since. Material quantity is optional.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS production_started_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS production_target_count INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS production_material_count INTEGER;

-- ─────────────────────────────────────────────────────────────────────────
-- Go-live hardening (security)
-- ─────────────────────────────────────────────────────────────────────────

-- #5: Token invalidation. A password change increments token_version;
-- issued JWTs carry their version and become invalid on mismatch.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'token_version'
    ) THEN
        ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
    END IF;
END $$;

-- #4: Audit log for auth events (login/logout/register/refresh/switch).
-- Forensics after a compromise. Retention (~90 days) is handled app-/cron-side
-- via DELETE.
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    email VARCHAR(255),
    event_type VARCHAR(50) NOT NULL,
    ip_address VARCHAR(64),
    user_agent TEXT,
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_email ON audit_logs(email);

-- Optional device token hardening: device_token_hash contains
-- HMAC-SHA256(server_key, token) as hex. Without a key, device_token stays active.
-- The two-phase tool never clears plaintext values automatically at backend start.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'device_token_hash'
    ) THEN
        ALTER TABLE devices ADD COLUMN device_token_hash VARCHAR(64);
    END IF;
END $$;
ALTER TABLE devices ALTER COLUMN device_token DROP NOT NULL;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_token_key;
DROP INDEX IF EXISTS idx_devices_token;
CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(device_token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_token_plain
    ON devices(device_token) WHERE device_token IS NOT NULL;

-- One-time claim: the customer registers the serial number + the device-specific
-- setup code (new devices use three hyphenated words; legacy codes stay valid).
-- Only its HMAC is stored in the DB. The short expiry window lets the device
-- retry HTTP requests safely without storing a readable device token on the
-- server.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS activation_claim_hash VARCHAR(64);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS activation_claim_expires_at TIMESTAMP;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP;
CREATE INDEX IF NOT EXISTS idx_devices_pending_activation
    ON devices(activation_claim_expires_at)
    WHERE activation_claim_hash IS NOT NULL;

-- Hit wire format v4: stable identity per boot and event. Because device_hits
-- is partitioned by recorded_at, PostgreSQL cannot enforce a global
-- unique key there without the partition key. The compact receipt table is
-- therefore the canonical deduplication lock for HTTP/offline retries.
ALTER TABLE device_hits ADD COLUMN IF NOT EXISTS boot_id BIGINT;
ALTER TABLE device_hits ADD COLUMN IF NOT EXISTS event_sequence BIGINT;
CREATE INDEX IF NOT EXISTS idx_device_hits_event_identity
    ON device_hits(device_id, boot_id, event_sequence)
    WHERE boot_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_hit_receipts (
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    boot_id BIGINT NOT NULL CHECK (boot_id > 0),
    event_sequence BIGINT NOT NULL CHECK (event_sequence > 0),
    recorded_at TIMESTAMP NOT NULL,
    PRIMARY KEY (device_id, boot_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_device_hit_receipts_recorded
    ON device_hit_receipts(recorded_at);

-- Articles/work steps/production runs removed (feature dropped) —
-- the stroke↔article mapping was never used in production. Idempotent drop
-- (order because of FKs: referencing tables first).
DROP TABLE IF EXISTS production_runs;
DROP TABLE IF EXISTS article_worksteps;
DROP TABLE IF EXISTS worksteps;
DROP TABLE IF EXISTS articles;

-- Remove dead detector/diagnostic paths directly and idempotently. The five
-- old-firmware values documented above are only kept until the
-- energy OTA rollout is complete.
ALTER TABLE devices DROP COLUMN IF EXISTS kmeans_params;
ALTER TABLE devices DROP COLUMN IF EXISTS std_start_threshold;
ALTER TABLE devices DROP COLUMN IF EXISTS std_end_threshold;
ALTER TABLE devices DROP COLUMN IF EXISTS g_mean;
ALTER TABLE devices DROP COLUMN IF EXISTS energy_threshold;
ALTER TABLE devices DROP COLUMN IF EXISTS hysterese_samples;
ALTER TABLE devices DROP COLUMN IF EXISTS hysterese_auto;
ALTER TABLE devices DROP COLUMN IF EXISTS min_schlag_dauer_ms;
ALTER TABLE devices DROP COLUMN IF EXISTS rise_threshold;
ALTER TABLE devices DROP COLUMN IF EXISTS ma_window;
ALTER TABLE devices DROP COLUMN IF EXISTS count_conf_cutoff;
ALTER TABLE devices DROP COLUMN IF EXISTS count_tune_level;
ALTER TABLE devices DROP COLUMN IF EXISTS count_gain;
ALTER TABLE devices DROP COLUMN IF EXISTS count_minact_ms;
ALTER TABLE devices DROP COLUMN IF EXISTS count_minact_changed_at;
ALTER TABLE devices DROP COLUMN IF EXISTS min_peak_g_changed_at;
ALTER TABLE devices DROP COLUMN IF EXISTS watchdog_releases;
ALTER TABLE devices DROP COLUMN IF EXISTS peak_gate_discards;

-- ML runtime artifacts are completely removed. The historical
-- ``counted`` column, however, is deliberately kept (see above).
DROP TABLE IF EXISTS learning_hit_samples;
DROP TABLE IF EXISTS model_versions;
ALTER TABLE device_hits DROP COLUMN IF EXISTS datum;
ALTER TABLE device_hits DROP COLUMN IF EXISTS zeit;
ALTER TABLE device_hits DROP COLUMN IF EXISTS is_lernmodus;
ALTER TABLE device_hits DROP COLUMN IF EXISTS rn;
ALTER TABLE device_hits DROP COLUMN IF EXISTS mlp_confidence;
ALTER TABLE companies DROP COLUMN IF EXISTS default_min_peak_g;

-- Phase 2 (open source, self-hosted): idempotently remove dropped features
-- – multi-company invitations, web push, labeling/learning mode/
-- data collection, OTA slot lock, factory registry and key fingerprints.
-- Order because of foreign keys: referencing tables first.
DROP TABLE IF EXISTS invitations;
DROP TABLE IF EXISTS notification_push_deliveries;
DROP TABLE IF EXISTS web_push_subscriptions;
DROP TABLE IF EXISTS learning_session_labels;
DROP TABLE IF EXISTS learning_session_chunks;
DROP TABLE IF EXISTS learning_session_samples;
DROP TABLE IF EXISTS learning_sessions;
DROP TABLE IF EXISTS device_factory_registry;
DROP TABLE IF EXISTS credential_key_fingerprints;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_labeling_collection_mode_check;
ALTER TABLE devices DROP COLUMN IF EXISTS labeling_collection_mode;
ALTER TABLE devices DROP COLUMN IF EXISTS lernmodus;
ALTER TABLE devices DROP COLUMN IF EXISTS pending_lern_grund;
ALTER TABLE devices DROP COLUMN IF EXISTS kalibrierung;
ALTER TABLE devices DROP COLUMN IF EXISTS kalibrierung_wartend;
ALTER TABLE devices DROP COLUMN IF EXISTS kalibrierung_event_count;
ALTER TABLE devices DROP COLUMN IF EXISTS ota_block_reason;
ALTER TABLE devices DROP COLUMN IF EXISTS ota_slot_size;
