# TEMPLATE – not published anywhere yet. For a personal tap (a GitHub repository
# named homebrew-<something>, file Casks/foriq.rb); see README.md next to this file.
# Replace every PLACEHOLDER before use. Foriq is ad-hoc signed and not notarized, so
# it does not meet the requirements of the official homebrew/cask repository.
cask "foriq" do
  version "0.0.0" # PLACEHOLDER: release version, e.g. "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000" # PLACEHOLDER: shasum -a 256 Foriq-<version>-arm64.dmg

  # PLACEHOLDER: download URL of the release DMG (GitHub release asset).
  url "https://example.invalid/PLACEHOLDER/Foriq-#{version}-arm64.dmg"
  name "Foriq"
  desc "Self-hosted machine stroke counting with ESP32 sensors"
  homepage "https://example.invalid/PLACEHOLDER"

  depends_on arch: :arm64
  # Electron 44+ requires macOS 13.
  depends_on macos: ">= :ventura"

  app "Foriq.app"

  # No zap stanza on purpose: ~/Library/Application Support/Foriq holds the database,
  # the backups and secrets.json that the sensors' tokens depend on.

  caveats <<~EOS
    Foriq is not notarized. Homebrew quarantines the download, so macOS blocks the
    first start ("Foriq" Not Opened). Click Done, then open
    System Settings > Privacy & Security, click "Open Anyway" next to
    "Foriq" was blocked to protect your Mac, and confirm.

    Your data stays in ~/Library/Application Support/Foriq across upgrades and
    uninstalls.
  EOS
end
