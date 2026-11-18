"""Internal CLI for the manually enabled external API.

Run from webapp/:
    PYTHONPATH=backend python backend/tools/api_access.py status customer-slug
"""

import argparse

from sqlalchemy import text

from utils.api_key_auth import generate_api_key, hash_api_key
from utils.db import make_con


def company(con, slug):
    row = con.execute(
        text("SELECT id, name, external_api_enabled FROM companies WHERE slug = :slug"),
        {"slug": slug},
    ).fetchone()
    if not row:
        raise SystemExit(f"Company with slug '{slug}' not found")
    return row


def main():
    parser = argparse.ArgumentParser(description="Manage Foriq API access")
    parser.add_argument("action", choices=["status", "enable", "disable", "create", "list", "revoke"])
    parser.add_argument("company_slug")
    parser.add_argument("--name", default="ERP-Integration")
    parser.add_argument("--key-id")
    args = parser.parse_args()

    with make_con() as con:
        target = company(con, args.company_slug)

        if args.action in {"enable", "disable"}:
            enabled = args.action == "enable"
            con.execute(
                text("UPDATE companies SET external_api_enabled = :enabled WHERE id = :cid"),
                {"enabled": enabled, "cid": str(target.id)},
            )
            con.commit()
            print(f"{target.name}: external API {'enabled' if enabled else 'disabled'}")
            return

        if args.action == "status":
            print(f"{target.name}: external API {'enabled' if target.external_api_enabled else 'disabled'}")
            return

        if args.action == "list":
            rows = con.execute(
                text(
                    "SELECT id, name, key_prefix, is_active, created_at, last_used_at "
                    "FROM api_keys WHERE company_id = :cid ORDER BY created_at DESC"
                ),
                {"cid": str(target.id)},
            ).fetchall()
            for row in rows:
                print(
                    f"{row.id}  {row.key_prefix}…  {'active' if row.is_active else 'revoked'}  "
                    f"{row.name}  last_used={row.last_used_at or 'never'}"
                )
            return

        if args.action == "create":
            if not target.external_api_enabled:
                raise SystemExit("Enable it first with 'enable'")
            raw_key, prefix = generate_api_key()
            row = con.execute(
                text(
                    "INSERT INTO api_keys (company_id, name, key_prefix, key_hash) "
                    "VALUES (:cid, :name, :prefix, :hash) RETURNING id"
                ),
                {
                    "cid": str(target.id),
                    "name": args.name.strip(),
                    "prefix": prefix,
                    "hash": hash_api_key(raw_key),
                },
            ).fetchone()
            con.commit()
            print(f"Key-ID: {row.id}")
            print(f"API key (shown only this once): {raw_key}")
            return

        if not args.key_id:
            raise SystemExit("'revoke' requires --key-id")
        result = con.execute(
            text(
                "UPDATE api_keys SET is_active = false, revoked_at = NOW() "
                "WHERE id = :kid AND company_id = :cid"
            ),
            {"kid": args.key_id, "cid": str(target.id)},
        )
        con.commit()
        if not result.rowcount:
            raise SystemExit("Key not found")
        print("API key revoked")


if __name__ == "__main__":
    main()
