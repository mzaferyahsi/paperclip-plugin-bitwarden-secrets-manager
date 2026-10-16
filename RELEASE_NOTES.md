# v0.1.1 release notes

## Summary
Operator surface rebuild plus fail-closed scope handling. **Real Bitwarden sync is intentionally unavailable on SDK 1.0.0** (see below).

## Changes
- Rebuilt settings page: stepper, enable switch, status overview, error-code messages (ALR-1421, ALR-1501).
- Scope model `bsmProjectSelections` (whole-project or selected secret IDs per project). Legacy `bsmProjectIds` still read as whole-project; saving migrates it. Both forms together are rejected.
- Selected IDs are verified against list metadata on save (no value read).
- Enabling a blocked company re-arms sync; the token input clears after save.
- Rate-limit backoff helper, scheduled-anchor preservation fix, unset-scope status no longer shows a spurious error.
- Version 0.1.1 in package, lockfile, manifest and Bitwarden user agent.

## Known limitation (fail-closed)
The SDK list call returns no project per secret. Membership is only returned with values. The plugin refuses to read values to learn it, so every scope fails with `project_membership_unavailable` before any value request. No secret is created, rotated, archived or deleted by a sync run. Documented in README and in the Scope step of the settings UI.

## Tag plan (not executed)
1. Security review (Vin) and QA verdict (Szeth) on the final diff.
2. Merge `release/v0.1.1` to `main` by PR.
3. Tag `v0.1.1` on the merge commit; `npm pack` and attach the tarball. Publish only on explicit board approval.
4. Follow-up: when the SDK lists project membership (ALR-1664), release 0.1.2 enabling sync, with a disposable-destination check first.
