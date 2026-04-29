# Smart Workspace - Changelog
## v1.0.38

- Update CHANGELOG for v1.0.37

## v1.0.37

- Record v1.0.36 changelog placeholder and normalise line endings
- EULA: clarify three-device limit applies to physical computers, not user profiles
- Installer creates machine-wide licence folder in ProgramData with shared ACLs
- Licence now covers all Windows accounts on the same PC (one activation per device)

## v1.0.36

- Maintenance release.

## v1.0.35

- Internal maintenance and packaging tweaks.

## v1.0.34

- 1-Click Routines now respect the selected category bar (All / Family / Work / custom).
- New "Category" dropdown in the Create / Edit Routine dialog.
- New routines default to the currently-selected category (or General when "All" is active).
- Legacy routines without a category are migrated to General automatically on load.

## v1.0.33

- Hardened Electron security defaults (sandbox, contextIsolation, no remote permissions).
- Atomic config writes with .bak fallback to prevent corruption on power loss.
- Bundled End User Licence Agreement; new "Legal & Licence" entry in Settings.
- Installer now shows the licence page before install.
- Removed dates from auto-generated changelog entries.

## v1.0.32

- Maintenance release.


## v1.0.31
- Added in-app "What's New" changelog viewer in Settings.
- Auto-popup once after each update with the latest release notes.
- Bundled CHANGELOG.md with the installer for offline access.
- Build pipeline now auto-generates release notes from git history on `npm run release`.

## v1.0.30
- Internal maintenance and packaging tweaks.

## v1.0.29
- New 6-step first-run Setup Wizard (Welcome / Theme / Startup / Simple View / Suggested Websites / Done).
- Curated library of 15 popular websites you can add with one click; favicons fetched automatically.
- Three category modes when adding suggested sites: All to General, All to Family, or Ask for each.
- Settings: new "Suggested Websites" shortcut to add curated sites at any time.
- Settings: "Replay Tutorial" renamed to "Replay Setup Wizard" and now relaunches the full wizard.

## v1.0.28
- Added a manual "Check Now" button in Settings to trigger an update check on demand.
- New `/api/check-for-updates` bridge between renderer and the auto-updater.

## v1.0.27
- Fixed: Simple View PIN now saves and updates independently of the on/off toggle.
- PIN management is no longer tied to enabling Simple Mode.

## v1.0.26
- Added Simple View / Family Mode for non-tech-savvy users (large tiles, big text, search).
- Optional 4-8 digit PIN to exit Simple View.
- Auto-creates a "Family" category when Simple View is enabled.
- Floating Settings button in Simple View for easy exit.

## v1.0.25
- Installer now checks GitHub for a newer release before installing and chain-launches it if found.
- Silent background updates via auto-updater; updates apply on next app quit.
- Replaced nagging update banner with a quiet status line in Settings.

## v1.0.24
- Updated Lemon Squeezy checkout URL to the new store endpoint.

## v1.0.23
- Fixed: scheme-less link URLs (e.g. `gmail.com`) now open in the default browser instead of inside the app.
- `https://` is auto-prepended to user-entered URLs that omit a scheme.
- Hardened external-link routing in the main process.
