# Homebrew cask (template)

`foriq.rb` is a template for a **personal tap**; it is not published. Fill in
`version`, `sha256`, `url` and `homepage` (all marked `PLACEHOLDER`), then put it into a
tap repository as `Casks/foriq.rb` (a GitHub repository named `homebrew-<name>`, see
`brew tap-new`). Users install it with:

```bash
brew install --cask <owner>/<name>/foriq     # trusts just this cask (Homebrew 6+ tap trust)
```

Things to know (checked against Homebrew 7.0.6 and its bundled docs):

- **Gatekeeper still applies.** Homebrew sets the quarantine attribute on every cask
  download and has no option to skip it, so the ad-hoc signed, non-notarized Foriq is
  blocked on first start exactly as after a browser download; the cask's `caveats`
  explain "Open Anyway". The Terminal installer (`scripts/install.sh`) avoids this.
- **No official cask.** `homebrew/cask` requires apps to pass Gatekeeper checks on a
  default macOS configuration (docs: *Acceptable Casks*). Foriq does not, so it cannot
  be submitted there unless it is signed with a Developer ID and notarized.
- **No `zap` stanza** on purpose: the data directory holds the database and backups.
