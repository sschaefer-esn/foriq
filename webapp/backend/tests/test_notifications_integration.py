import os
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text

import notifications
from utils.auth_utils import create_token
from utils.db import make_con


test_app = FastAPI()
test_app.include_router(notifications.router)
client = TestClient(test_app)


@unittest.skipUnless(
    os.getenv("FORIQ_INTEGRATION_DB") == "1",
    "requires an isolated PostgreSQL test database with the current schema.sql",
)
class NotificationIntegrationTests(unittest.TestCase):
    """End-to-end DB contract for the product notification center."""

    monday = datetime(2026, 8, 17, 7, 0, tzinfo=timezone.utc)

    def setUp(self):
        suffix = uuid.uuid4().hex
        self.company_id = str(uuid.uuid4())
        self.foreign_company_id = str(uuid.uuid4())
        self.device_id = str(uuid.uuid4())
        self.foreign_device_id = str(uuid.uuid4())
        self.user_a_id = str(uuid.uuid4())
        self.user_b_id = str(uuid.uuid4())
        self.foreign_user_id = str(uuid.uuid4())
        self.emails = {
            self.user_a_id: f"notification-a-{suffix}@example.invalid",
            self.user_b_id: f"notification-b-{suffix}@example.invalid",
            self.foreign_user_id: f"notification-foreign-{suffix}@example.invalid",
        }

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO companies (id, name, slug, timezone) VALUES "
                    "(:cid, 'Notification Test', :slug, 'Europe/Berlin'), "
                    "(:foreign_cid, 'Foreign Notification Test', :foreign_slug, 'Europe/Berlin')"
                ),
                {
                    "cid": self.company_id,
                    "slug": f"notification-{suffix}",
                    "foreign_cid": self.foreign_company_id,
                    "foreign_slug": f"notification-foreign-{suffix}",
                },
            )
            for user_id, email in self.emails.items():
                con.execute(
                    text(
                        "INSERT INTO users (id, email, password_hash, name) "
                        "VALUES (:id, :email, 'unused-in-integration-test', :name)"
                    ),
                    {"id": user_id, "email": email, "name": f"User {user_id}"},
                )
            con.execute(
                text(
                    "INSERT INTO memberships (user_id, company_id, role) VALUES "
                    "(:user_a, :cid, 'owner'), (:user_b, :cid, 'viewer'), "
                    "(:foreign_user, :foreign_cid, 'viewer')"
                ),
                {
                    "user_a": self.user_a_id,
                    "user_b": self.user_b_id,
                    "foreign_user": self.foreign_user_id,
                    "cid": self.company_id,
                    "foreign_cid": self.foreign_company_id,
                },
            )
            con.execute(
                text(
                    "INSERT INTO devices "
                    "(id, company_id, name, serial_number, is_active, last_seen_at, "
                    "upload_interval_s) VALUES "
                    "(:did, :cid, 'Test press', :serial, true, :seen, 30), "
                    "(:foreign_did, :foreign_cid, 'Foreign press', :foreign_serial, true, :seen, 30)"
                ),
                {
                    "did": self.device_id,
                    "cid": self.company_id,
                    "serial": f"NOTIFICATION-{suffix}",
                    "foreign_did": self.foreign_device_id,
                    "foreign_cid": self.foreign_company_id,
                    "foreign_serial": f"NOTIFICATION-FOREIGN-{suffix}",
                    "seen": self._naive(self.monday - timedelta(seconds=10)),
                },
            )
            con.commit()

    def tearDown(self):
        with make_con() as con:
            con.execute(
                text("DELETE FROM companies WHERE id IN (:cid, :foreign_cid)"),
                {"cid": self.company_id, "foreign_cid": self.foreign_company_id},
            )
            con.execute(
                text("DELETE FROM users WHERE id IN (:user_a, :user_b, :foreign_user)"),
                {
                    "user_a": self.user_a_id,
                    "user_b": self.user_b_id,
                    "foreign_user": self.foreign_user_id,
                },
            )
            con.commit()

    @staticmethod
    def _naive(value):
        return value.astimezone(timezone.utc).replace(tzinfo=None)

    def _put_rule(
        self,
        *,
        updated_at,
        threshold_minutes=5,
        require_work_phase=False,
        minimum_work_minutes=5,
        notify_activity_resumed=True,
        notify_device_offline=False,
    ):
        self.rule_id = str(uuid.uuid4())
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO notification_rules "
                    "(id, company_id, name, enabled, threshold_minutes, "
                    "require_work_phase, minimum_work_minutes, notify_activity_resumed, "
                    "notify_device_offline, "
                    "weekly_windows, updated_at) "
                    "VALUES (:rid, :cid, 'Test rule', true, :threshold, :require_work, "
                    ":minimum_work, :notify_activity_resumed, :notify_offline, "
                    "CAST(:windows AS jsonb), :updated_at)"
                ),
                {
                    "rid": self.rule_id,
                    "cid": self.company_id,
                    "threshold": threshold_minutes,
                    "require_work": require_work_phase,
                    "minimum_work": minimum_work_minutes,
                    "notify_activity_resumed": notify_activity_resumed,
                    "notify_offline": notify_device_offline,
                    "windows": '[{"days":[1,2,3,4,5],"start":"08:00","end":"10:00"}]',
                    "updated_at": self._naive(updated_at),
                },
            )
            con.execute(
                text(
                    "INSERT INTO notification_rule_devices (rule_id, device_id) "
                    "VALUES (:rid, :did)"
                ),
                {"rid": self.rule_id, "did": self.device_id},
            )
            con.commit()

    def _incidents(self, device_id=None):
        with make_con() as con:
            return con.execute(
                text(
                    "SELECT id, alert_type, triggered_at, resolved_at, resolution "
                    "FROM notification_incidents WHERE device_id = :did "
                    "ORDER BY triggered_at, alert_type"
                ),
                {"did": device_id or self.device_id},
            ).fetchall()

    def _insert_counted_hits(self, *recorded_at_values):
        with make_con() as con:
            for recorded_at in recorded_at_values:
                con.execute(
                    text(
                        "INSERT INTO device_hits "
                        "(device_id, gforce, recorded_at, counted) "
                        "VALUES (:did, 1.5, :recorded_at, true)"
                    ),
                    {
                        "did": self.device_id,
                        "recorded_at": self._naive(recorded_at),
                    },
                )
            con.commit()

    def _token(self, user_id, company_id):
        return create_token(
            user_id=user_id,
            email=self.emails[user_id],
            role="viewer",
            company_id=company_id,
            name="Notification Integration Test",
            company_name="Token value is not authoritative",
        )

    @staticmethod
    def _headers(token):
        return {"Authorization": f"Bearer {token}"}

    def _insert_incident(self, *, company_id, device_id, alert_type="no_hits"):
        with make_con() as con:
            incident_id = con.execute(
                text(
                    "INSERT INTO notification_incidents "
                    "(company_id, device_id, rule_revision, alert_type, window_start_at, "
                    "window_end_at, condition_since_at) "
                    "VALUES (:cid, :did, 1, :kind, NOW() - interval '1 hour', "
                    "NOW() + interval '1 hour', NOW() - interval '10 minutes') "
                    "RETURNING id"
                ),
                {"cid": company_id, "did": device_id, "kind": alert_type},
            ).scalar_one()
            con.commit()
        return str(incident_id)

    def test_weekday_rule_opens_exactly_once_at_threshold_across_workers(self):
        threshold_started = self.monday - timedelta(minutes=5)
        self._put_rule(updated_at=threshold_started, threshold_minutes=5)

        notifications.evaluate_notification_rules(
            self.monday - timedelta(microseconds=1)
        )
        self.assertEqual(self._incidents(), [])

        barrier = threading.Barrier(3)

        def evaluate_as_worker():
            barrier.wait()
            return notifications.evaluate_notification_rules(self.monday)

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(evaluate_as_worker) for _ in range(2)]
            barrier.wait()
            [future.result(timeout=10) for future in futures]

        incidents = self._incidents()
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].alert_type, "no_hits")
        self.assertIsNone(incidents[0].resolved_at)
        with make_con() as con:
            snapshot = con.execute(
                text(
                    "SELECT rule_id, rule_name FROM notification_incidents "
                    "WHERE id = :id"
                ),
                {"id": str(incidents[0].id)},
            ).fetchone()
        self.assertEqual(str(snapshot.rule_id), self.rule_id)
        self.assertEqual(snapshot.rule_name, "Test rule")

        notifications.evaluate_notification_rules(self.monday)
        self.assertEqual(len(self._incidents()), 1)

    def test_persisted_latch_blocks_duplicate_for_same_idle_period(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
        )
        notifications.evaluate_notification_rules(self.monday)
        incident = self._incidents()[0]

        # Even if an incident were closed outside the normal flow, the same
        # unchanged idle period must not raise a new alert.
        with make_con() as con:
            con.execute(
                text(
                    "UPDATE notification_incidents SET resolved_at = :resolved, "
                    "resolution = 'rule_changed' WHERE id = :id"
                ),
                {"id": str(incident.id), "resolved": self._naive(self.monday)},
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)

        self.assertEqual(len(self._incidents()), 1)
        with make_con() as con:
            latched = con.execute(
                text(
                    "SELECT no_hits_notification_sent "
                    "FROM notification_rule_devices "
                    "WHERE rule_id = :rid AND device_id = :did"
                ),
                {"rid": self.rule_id, "did": self.device_id},
            ).scalar_one()
        self.assertTrue(latched)

    def test_sensor_flap_does_not_reopen_the_same_stall(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
        )
        notifications.evaluate_notification_rules(self.monday)

        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {
                    "did": self.device_id,
                    "seen": self._naive(self.monday - timedelta(minutes=10)),
                },
            )
            con.commit()
        notifications.evaluate_notification_rules(self.monday)

        # The sensor is back online but the machine has not produced a new
        # stroke yet: the same downtime stays locked.
        online_at = self.monday + timedelta(minutes=10)
        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {"did": self.device_id, "seen": self._naive(online_at)},
            )
            con.commit()
        notifications.evaluate_notification_rules(online_at)
        self.assertEqual(len(self._incidents()), 1)

        # Only a genuinely new stroke releases the lock for the next idle period.
        resumed_at = self.monday + timedelta(minutes=11)
        self._insert_counted_hits(resumed_at)
        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {"did": self.device_id, "seen": self._naive(resumed_at)},
            )
            con.commit()
        notifications.evaluate_notification_rules(resumed_at)

        next_stall_at = self.monday + timedelta(minutes=17)
        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {"did": self.device_id, "seen": self._naive(next_stall_at)},
            )
            con.commit()
        notifications.evaluate_notification_rules(next_stall_at)
        self.assertEqual(len(self._incidents()), 2)

    def test_saving_rule_keeps_existing_stall_latch(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
        )
        notifications.evaluate_notification_rules(self.monday)

        response = client.put(
            f"/api/v1/notifications/rule-sets/{self.rule_id}",
            headers=self._headers(self._token(self.user_a_id, self.company_id)),
            json={
                "name": "Test rule",
                "enabled": True,
                "threshold_minutes": 5,
                "require_work_phase": False,
                "minimum_work_minutes": 5,
                "notify_activity_resumed": True,
                "notify_device_offline": False,
                "weekly_windows": [
                    {
                        "days": [1, 2, 3, 4, 5],
                        "start": "08:00",
                        "end": "10:00",
                    }
                ],
                "device_ids": [self.device_id],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        with make_con() as con:
            latched = con.execute(
                text(
                    "SELECT no_hits_notification_sent "
                    "FROM notification_rule_devices WHERE rule_id = :rid"
                ),
                {"rid": self.rule_id},
            ).scalar_one()
        self.assertTrue(latched)

    def test_work_pause_sequence_requires_a_long_enough_work_phase(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=20),
            threshold_minutes=5,
            require_work_phase=True,
            minimum_work_minutes=5,
        )
        self._insert_counted_hits(
            self.monday - timedelta(minutes=9),
            self.monday - timedelta(minutes=5),
        )

        notifications.evaluate_notification_rules(self.monday)

        self.assertEqual(self._incidents(), [])

    def test_work_pause_sequence_alerts_after_work_then_pause(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=20),
            threshold_minutes=5,
            require_work_phase=True,
            minimum_work_minutes=5,
        )
        self._insert_counted_hits(
            self.monday - timedelta(minutes=10),
            self.monday - timedelta(minutes=6),
            self.monday - timedelta(minutes=5),
        )

        notifications.evaluate_notification_rules(self.monday)

        incidents = self._incidents()
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].alert_type, "no_hits")

    def test_work_pause_sequence_ignores_a_machine_that_never_started(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=20),
            threshold_minutes=5,
            require_work_phase=True,
            minimum_work_minutes=5,
        )

        notifications.evaluate_notification_rules(self.monday)

        self.assertEqual(self._incidents(), [])

    def test_work_pause_sequence_uses_only_the_latest_work_phase(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=30),
            threshold_minutes=5,
            require_work_phase=True,
            minimum_work_minutes=5,
        )
        self._insert_counted_hits(
            self.monday - timedelta(minutes=25),
            self.monday - timedelta(minutes=21),
            self.monday - timedelta(minutes=20),
            self.monday - timedelta(minutes=5),
        )

        notifications.evaluate_notification_rules(self.monday)

        self.assertEqual(self._incidents(), [])

    def test_fresh_counted_hit_resolves_stall_but_candidate_does_not(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10), threshold_minutes=5
        )
        notifications.evaluate_notification_rules(self.monday)
        incident = self._incidents()[0]
        self.assertEqual(incident.alert_type, "no_hits")

        with make_con() as con:
            con.execute(
                text(
                    "UPDATE notification_incidents SET triggered_at = :triggered "
                    "WHERE id = :id"
                ),
                {
                    "id": str(incident.id),
                    "triggered": self._naive(self.monday - timedelta(minutes=1)),
                },
            )
            con.execute(
                text(
                    "INSERT INTO device_hits (device_id, gforce, recorded_at, counted) "
                    "VALUES (:did, 1.0, :recorded_at, false)"
                ),
                {
                    "did": self.device_id,
                    "recorded_at": self._naive(self.monday - timedelta(seconds=30)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)
        self.assertIsNone(self._incidents()[0].resolved_at)

        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO device_hits (device_id, gforce, recorded_at, counted) "
                    "VALUES (:did, 1.5, :recorded_at, true)"
                ),
                {
                    "did": self.device_id,
                    "recorded_at": self._naive(self.monday - timedelta(seconds=5)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)
        incidents = self._incidents()
        self.assertEqual(len(incidents), 1)
        self.assertIsNotNone(incidents[0].resolved_at)
        self.assertEqual(incidents[0].resolution, "activity_resumed")
        with make_con() as con:
            latched = con.execute(
                text(
                    "SELECT no_hits_notification_sent "
                    "FROM notification_rule_devices WHERE rule_id = :rid"
                ),
                {"rid": self.rule_id},
            ).scalar_one()
        self.assertFalse(latched)

    def test_activity_resumed_notification_can_be_suppressed(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
            notify_activity_resumed=False,
        )
        notifications.evaluate_notification_rules(self.monday)
        incident = self._incidents()[0]

        with make_con() as con:
            con.execute(
                text(
                    "UPDATE notification_incidents SET triggered_at = :triggered "
                    "WHERE id = :id"
                ),
                {
                    "id": str(incident.id),
                    "triggered": self._naive(self.monday - timedelta(minutes=1)),
                },
            )
            con.execute(
                text(
                    "INSERT INTO device_hits (device_id, gforce, recorded_at, counted) "
                    "VALUES (:did, 1.5, :recorded_at, true)"
                ),
                {
                    "did": self.device_id,
                    "recorded_at": self._naive(self.monday - timedelta(seconds=5)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)

        resolved = self._incidents()[0]
        self.assertEqual(resolved.resolution, "activity_resumed")
        response = client.get(
            "/api/v1/notifications",
            headers=self._headers(self._token(self.user_a_id, self.company_id)),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()[0]["notify_activity_resumed"])

    def test_offline_incident_resolves_and_suppresses_no_hits(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
            notify_device_offline=True,
        )
        notifications.evaluate_notification_rules(self.monday)
        self.assertEqual(self._incidents()[0].alert_type, "no_hits")

        with make_con() as con:
            con.execute(
                text(
                    "UPDATE devices SET last_seen_at = :seen WHERE id = :did"
                ),
                {
                    "did": self.device_id,
                    "seen": self._naive(self.monday - timedelta(minutes=10)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)
        incidents = self._incidents()
        self.assertEqual(len(incidents), 2)
        by_type = {incident.alert_type: incident for incident in incidents}
        self.assertEqual(by_type["no_hits"].resolution, "sensor_offline")
        self.assertIsNotNone(by_type["no_hits"].resolved_at)
        self.assertIsNone(by_type["device_offline"].resolved_at)

        notifications.evaluate_notification_rules(self.monday)
        open_incidents = [row for row in self._incidents() if row.resolved_at is None]
        self.assertEqual(len(open_incidents), 1)
        self.assertEqual(open_incidents[0].alert_type, "device_offline")

    def test_offline_incident_is_suppressed_by_default(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
        )
        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {
                    "did": self.device_id,
                    "seen": self._naive(self.monday - timedelta(minutes=10)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)
        self.assertEqual(self._incidents(), [])

    def test_disabling_offline_alert_keeps_stall_incident_open(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
            notify_device_offline=True,
        )
        self._insert_incident(
            company_id=self.company_id,
            device_id=self.device_id,
            alert_type="no_hits",
        )
        self._insert_incident(
            company_id=self.company_id,
            device_id=self.device_id,
            alert_type="device_offline",
        )
        owner_headers = self._headers(
            self._token(self.user_a_id, self.company_id)
        )
        response = client.put(
            f"/api/v1/notifications/rule-sets/{self.rule_id}",
            headers=owner_headers,
            json={
                "name": "Test rule",
                "enabled": True,
                "threshold_minutes": 5,
                "notify_device_offline": False,
                "weekly_windows": [
                    {
                        "days": [1, 2, 3, 4, 5],
                        "start": "08:00",
                        "end": "10:00",
                    }
                ],
                "device_ids": [self.device_id],
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        by_type = {incident.alert_type: incident for incident in self._incidents()}
        self.assertIsNone(by_type["no_hits"].resolved_at)
        self.assertIsNotNone(by_type["device_offline"].resolved_at)
        self.assertEqual(by_type["device_offline"].resolution, "rule_changed")

    def test_sleep_mode_keeps_stall_detection_but_uses_24h_offline_threshold(self):
        self._put_rule(
            updated_at=self.monday - timedelta(minutes=10),
            threshold_minutes=5,
            notify_device_offline=True,
        )
        with make_con() as con:
            con.execute(
                text(
                    "UPDATE devices SET sleep_mode = true, last_seen_at = :seen "
                    "WHERE id = :did"
                ),
                {
                    "did": self.device_id,
                    "seen": self._naive(self.monday - timedelta(minutes=1)),
                },
            )
            con.commit()

        notifications.evaluate_notification_rules(self.monday)
        incidents = self._incidents()
        self.assertEqual(len(incidents), 1)
        self.assertEqual(incidents[0].alert_type, "no_hits")
        self.assertIsNone(incidents[0].resolved_at)

        with make_con() as con:
            con.execute(
                text("UPDATE devices SET last_seen_at = :seen WHERE id = :did"),
                {
                    "did": self.device_id,
                    "seen": self._naive(self.monday - timedelta(hours=25)),
                },
            )
            con.commit()
        notifications.evaluate_notification_rules(self.monday)
        by_type = {incident.alert_type: incident for incident in self._incidents()}
        self.assertEqual(by_type["no_hits"].resolution, "sensor_offline")
        self.assertIsNone(by_type["device_offline"].resolved_at)

    def test_read_state_is_per_user_and_company_isolation_is_enforced(self):
        own_incident = self._insert_incident(
            company_id=self.company_id, device_id=self.device_id
        )
        foreign_incident = self._insert_incident(
            company_id=self.foreign_company_id,
            device_id=self.foreign_device_id,
        )
        user_a_headers = self._headers(
            self._token(self.user_a_id, self.company_id)
        )
        user_b_headers = self._headers(
            self._token(self.user_b_id, self.company_id)
        )
        foreign_headers = self._headers(
            self._token(self.foreign_user_id, self.foreign_company_id)
        )

        user_a_before = client.get("/api/v1/notifications", headers=user_a_headers)
        user_b_before = client.get("/api/v1/notifications", headers=user_b_headers)
        self.assertEqual(user_a_before.status_code, 200)
        self.assertEqual(user_b_before.status_code, 200)
        self.assertEqual([row["id"] for row in user_a_before.json()], [own_incident])
        self.assertTrue(user_a_before.json()[0]["unread"])
        self.assertTrue(user_b_before.json()[0]["unread"])

        marked = client.post(
            f"/api/v1/notifications/{own_incident}/read", headers=user_a_headers
        )
        self.assertEqual(marked.status_code, 200)
        self.assertFalse(
            client.get("/api/v1/notifications", headers=user_a_headers).json()[0][
                "unread"
            ]
        )
        self.assertTrue(
            client.get("/api/v1/notifications", headers=user_b_headers).json()[0][
                "unread"
            ]
        )

        foreign_list = client.get(
            "/api/v1/notifications", headers=foreign_headers
        )
        self.assertEqual(foreign_list.status_code, 200)
        self.assertEqual(
            [row["id"] for row in foreign_list.json()], [foreign_incident]
        )
        denied = client.post(
            f"/api/v1/notifications/{own_incident}/read", headers=foreign_headers
        )
        self.assertEqual(denied.status_code, 404)

    def test_rule_set_crud_conflict_and_tenant_boundary(self):
        owner_headers = self._headers(self._token(self.user_a_id, self.company_id))
        viewer_headers = self._headers(self._token(self.user_b_id, self.company_id))
        payload = {
            "name": "Early shift",
            "enabled": True,
            "threshold_minutes": 7,
            "weekly_windows": [
                {"days": [1, 2, 3, 4, 5], "start": "06:00", "end": "14:00"}
            ],
            "device_ids": [self.device_id],
        }

        created = client.post(
            "/api/v1/notifications/rule-sets",
            headers=owner_headers,
            json=payload,
        )
        self.assertEqual(created.status_code, 201, created.text)
        rule_id = created.json()["id"]
        self.assertEqual(created.json()["device_ids"], [self.device_id])
        self.assertFalse(created.json()["notify_device_offline"])
        self.assertFalse(created.json()["require_work_phase"])
        self.assertEqual(created.json()["minimum_work_minutes"], 5)
        self.assertTrue(created.json()["notify_activity_resumed"])

        visible = client.get(
            "/api/v1/notifications/rule-sets", headers=viewer_headers
        )
        self.assertEqual(visible.status_code, 200)
        self.assertEqual([row["id"] for row in visible.json()], [rule_id])

        conflict = client.post(
            "/api/v1/notifications/rule-sets",
            headers=owner_headers,
            json={**payload, "name": "Duplicate"},
        )
        self.assertEqual(conflict.status_code, 409)

        foreign = client.put(
            f"/api/v1/notifications/rule-sets/{rule_id}",
            headers=owner_headers,
            json={**payload, "device_ids": [self.foreign_device_id]},
        )
        self.assertEqual(foreign.status_code, 404)

        updated = client.put(
            f"/api/v1/notifications/rule-sets/{rule_id}",
            headers=owner_headers,
            json={
                **payload,
                "name": "Early shift presses",
                "threshold_minutes": 9,
                "require_work_phase": True,
                "minimum_work_minutes": 6,
                "notify_activity_resumed": False,
                "notify_device_offline": True,
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["name"], "Early shift presses")
        self.assertEqual(updated.json()["threshold_minutes"], 9)
        self.assertTrue(updated.json()["require_work_phase"])
        self.assertEqual(updated.json()["minimum_work_minutes"], 6)
        self.assertFalse(updated.json()["notify_activity_resumed"])
        self.assertTrue(updated.json()["notify_device_offline"])

        denied = client.delete(
            f"/api/v1/notifications/rule-sets/{rule_id}", headers=viewer_headers
        )
        self.assertEqual(denied.status_code, 403)
        deleted = client.delete(
            f"/api/v1/notifications/rule-sets/{rule_id}", headers=owner_headers
        )
        self.assertEqual(deleted.status_code, 200)
        with make_con() as con:
            legacy_count = con.execute(
                text(
                    "SELECT COUNT(*) FROM device_notification_rules "
                    "WHERE device_id = :did"
                ),
                {"did": self.device_id},
            ).scalar()
        self.assertEqual(legacy_count, 0)

    def test_legacy_device_put_splits_shared_rule(self):
        second_device_id = str(uuid.uuid4())
        with make_con() as con:
            con.execute(
                text(
                    "INSERT INTO devices "
                    "(id, company_id, name, serial_number, is_active, last_seen_at) "
                    "VALUES (:did, :cid, 'Second press', :serial, true, :seen)"
                ),
                {
                    "did": second_device_id,
                    "cid": self.company_id,
                    "serial": f"NOTIFICATION-SECOND-{uuid.uuid4().hex}",
                    "seen": self._naive(self.monday),
                },
            )
            con.commit()

        owner_headers = self._headers(self._token(self.user_a_id, self.company_id))
        shared = client.post(
            "/api/v1/notifications/rule-sets",
            headers=owner_headers,
            json={
                "name": "Shared rule",
                "enabled": True,
                "threshold_minutes": 5,
                "weekly_windows": [
                    {"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "16:00"}
                ],
                "device_ids": [self.device_id, second_device_id],
            },
        )
        self.assertEqual(shared.status_code, 201, shared.text)

        legacy = client.put(
            f"/api/v1/notifications/rules/{self.device_id}",
            headers=owner_headers,
            json={
                "enabled": True,
                "threshold_minutes": 12,
                "weekly_windows": [
                    {"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "16:00"}
                ],
            },
        )
        self.assertEqual(legacy.status_code, 200, legacy.text)
        self.assertEqual(legacy.json()["threshold_minutes"], 12)

        with make_con() as con:
            mappings = con.execute(
                text(
                    "SELECT rd.device_id, rd.rule_id FROM notification_rule_devices rd "
                    "JOIN notification_rules r ON r.id = rd.rule_id "
                    "WHERE r.company_id = :cid"
                ),
                {"cid": self.company_id},
            ).fetchall()
        by_device = {str(row.device_id): str(row.rule_id) for row in mappings}
        self.assertNotEqual(by_device[self.device_id], by_device[second_device_id])


if __name__ == "__main__":
    unittest.main()
