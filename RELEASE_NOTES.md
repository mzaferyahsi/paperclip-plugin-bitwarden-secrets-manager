# v0.1.2 release notes

## Summary
Real sync is available on SDK 1.0.0. The plugin now reads all secrets, groups them by project, and syncs the ones you select: all secrets, whole projects, individual secrets, or a mix.

## Important: organisation secret values pass through worker memory (intentional)
The Bitwarden SDK 1.0.0 `secrets().list` call returns no project. `getByIds` returns the project together with the value. To group secrets by project, discovery and every sync run therefore read the value of **every** secret in the organisation into the plugin worker's memory. The board decided this on 2026-10-17 (ALR-1698). It replaces the earlier rule "never read a value outside the selected scope". Nothing else is relaxed:
- Each value is dropped as soon as its batch is classified. Only ids, key names and project ids are kept for the catalogue.
- Values never go to the UI, state, config, logs, activity or error text.
- Only selected secrets are written to Paperclip native secrets.
- Loading the catalogue needs the same setup authority as changing settings.

## Changes
- Settings page: "Load secrets" builds a grouped, collapsible list (project, counts, key names only). Choose All secrets, whole projects, individual secrets, or a mix. A "No project" group holds secrets with no project. A summary shows "N secrets from M projects" before Save. Secrets whose project Bitwarden does not report are listed as not selectable.
- Sync reads every listed secret when the list carries no project, keeps only secrets the selection admits, and re-checks the selection every run. A selected project that no longer exists stops the run with `selected_project_missing` and changes nothing.
- Removal rules are unchanged: an incomplete snapshot (including any secret with an unreadable project) never authorizes a removal, and narrowing the selection never archives.
- Removed: the `project_membership_unavailable` fail-closed limitation and the "no scope syncs" text. There is no secret-count cap: discovery and sync read every secret in batches; a failing batch or the 10-minute budget reports "Discovery incomplete" and never authorises removals. The selection UI pages groups and secrets, has search by key name or project, shows true totals, and Select all applies to all matches across pages. Very large organisations may need several runs to finish a first complete snapshot; removals stay paused until a run completes.
- Version 0.1.2 in package, lockfile, manifest and Bitwarden user agent.

## Verification
Unit tests (grouping, mixed selection, No project, missing projectId, 1,250 secrets across 40 projects, batch retry and time-budget incompleteness, selection across pages, search + select-all, true counts, no value in any UI payload, state or write). A packed install on the QA host with a stub SDK is run by QA before tagging. No real Bitwarden account test has been done.

## Release plan
1. Value-handling review (Vin), grouped-selection UI review (Shai), acceptance on the packed build with a stub SDK (Szeth/Marasi).
2. Merge to `main`, tag `v0.1.2`, GitHub release with the tarball attached. No npm publish. Licence unchanged.
