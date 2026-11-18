# Contributing

Thanks for your interest in Foriq.

## Issues

- Bugs: describe what you did, what you expected and what happened. Include the
  component (firmware, backend, web UI, app), the firmware version and sensor model if
  relevant, and log excerpts (`~/Library/Application Support/Foriq/logs/`) with
  personal data removed.
- Security problems: do not open a public issue, see [SECURITY.md](SECURITY.md).
- Larger changes: open an issue first so the approach can be discussed.

## Pull requests

- Keep pull requests small and focused on one topic; avoid unrelated refactoring.
- Describe what changed and how you tested it.
- Update the documentation in `docs/` and `CHANGELOG.md` (section "Unreleased") when
  behaviour, commands or the protocol change.

Development setup: [docs/development.md](docs/development.md).

## Conventions

- English in code, comments, logs, commit messages and documentation. User-facing text
  goes through the translation dictionaries (English and German).
- Frontend and app: JavaScript, no TypeScript.
- Backend: SQLAlchemy `text()` queries with bound parameters, no ORM models.
- Database changes go into `webapp/sql/schema.sql` and must stay idempotent; the app
  applies the file on every start.
- Firmware changes bump `firmware-cpp/VERSION` (SemVer) and must keep the image below
  70 % of the OTA slot (checked by the build).
- Follow the existing style and [.editorconfig](.editorconfig).

## Checks before submitting

```bash
# backend (from webapp/backend, in .venv with requirements-dev.txt)
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/foriq_test JWT_SECRET=test \
  python -m unittest discover -s tests

# web UI (from webapp/frontend)
npm run lint && npm test && npm run build

# firmware (from firmware-cpp), if changed
pio run -e m5sticks3
```

Integration tests need a disposable PostgreSQL database, see the
[README's Commands section](README.md#backend-webappbackend).

## License

Foriq is licensed under the GNU Affero General Public License v3.0 only
(`AGPL-3.0-only`, see [LICENSE](LICENSE)). By submitting a contribution you agree that it
is licensed under AGPL-3.0-only as well. Code taken from elsewhere must come under a
license compatible with that and keep its notices (see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
