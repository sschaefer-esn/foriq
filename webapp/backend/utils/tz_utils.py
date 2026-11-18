from sqlalchemy import text


def get_company_tz(con, company_id: str) -> str:
    row = con.execute(
        text("SELECT timezone FROM companies WHERE id = :cid"),
        {"cid": company_id},
    ).fetchone()
    return row.timezone if row and row.timezone else "Europe/Berlin"
