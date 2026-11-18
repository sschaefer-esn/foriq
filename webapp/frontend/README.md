# Foriq web frontend

The Foriq web interface: Next.js (App Router, JavaScript), Tailwind CSS and
shadcn/ui. It is built as a static export and served by the Foriq backend on
the same origin as the API — there is no separate frontend server in
production.

## Development

Start the backend on port 8005 (see the repository README), then:

```bash
npm install
npm run dev        # http://localhost:3000
```

`next dev` forwards `/api/*` to `http://localhost:8005` (override with
`FORIQ_DEV_BACKEND`), see `next.config.mjs`.

## Production build

```bash
npm run build      # static export to out/
```

Point the backend at the export with `FORIQ_FRONTEND_DIR=/path/to/webapp/frontend/out`;
it then serves the UI and resolves deep links such as `/devices`.

## Fonts

Inter (`public/fonts/Inter-Variable.ttf`, SIL OFL 1.1) is the default typeface. The
optional display font Clash Grotesk is not distributed with the project (its license
does not allow it): to use it, place your own licensed copy at
`public/fonts/ClashGrotesk-Variable.ttf` (git-ignored) before `npm run build`.
`src/app/layout.js` checks for the file at build time and then puts Clash first in the
font stack with Inter as fallback; without the file the build uses Inter only.

## Checks

```bash
npm run lint
npm test           # node --test tests/*.test.mjs
```

## Translations

- The UI defaults to German; English is selectable under Settings and stored in `localStorage` (`foriq-locale`). The browser language is ignored. The default lives in `src/lib/i18n/defaultLocale.js` (`DEFAULT_LOCALE`); the static export is prerendered in that language (`<html lang>` in `src/app/layout.js`, `manifest.js` and page titles are German too).
- UI text lives in `src/lib/i18n/de/<area>.js` (German, default) and `src/lib/i18n/en/<area>.js` (English), as flat `"area.key": "text"` maps. Lookup falls back chosen locale → `de` → `en` → key.
- In components: `const t = useT();` then `t("devices.empty.title", { name })`; plurals are `{ one, other }` values picked by `vars.count`.
- Dates and numbers use `useLocale().intlLocale` (`en-GB` or `de-DE`); outside React use `translate()` / `getIntlLocale()`.
- Backend error texts are English; `src/lib/i18n/apiErrors.de.js` maps them to German, applied via `apiErrorMessage()` in `src/lib/api.js`.
- `npm test` fails if `en` and `de` key sets differ or a `t("…")` key is missing; the language is chosen under Settings → General.
