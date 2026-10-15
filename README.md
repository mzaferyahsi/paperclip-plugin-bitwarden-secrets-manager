# Paperclip Plugin: Bitwarden Secrets Manager Sync

# Bitwarden Secrets Manager Sync for Paperclip

This repository packages a Paperclip plugin for mirroring selected Bitwarden Secrets Manager items into native company secrets. The plugin uses native assignment, versioning, usage, access events, and authorization. It does not add a secret provider or modify the Paperclip server.

The worker reads selected Bitwarden Secrets Manager values and reconciles them with owned native company secrets. It stores only non-value journal and version metadata. Live synchronization remains disabled until an operator configures approved credentials and explicitly enables a company.

## Build

Supported package target: Linux x64 with GNU libc, Node.js 24.11 or newer.

```sh
npm ci
npm run check:bitwarden-deps
npm run validate:manifest
npm run typecheck
npm test
npm run build
npm pack
```

The native Bitwarden SDK is external to the worker bundle. Install the package with `npm ci` so npm installs its official Linux x64 GNU platform package. The SDK is separately licensed; see [NOTICE.md](NOTICE.md). Other architectures, musl Linux, custom Bitwarden servers, and Windows/macOS are not supported by this package build.

## Configure credentials

Configure a disabled company plugin record first. Set the Paperclip API origin, an existing native `paperclipApiToken` ref for runtime calls, and a temporary `paperclipSetupApiToken` ref for settings-page actions. The setup ref must authenticate the same instance-admin user opening the settings page and must be removed and revoked after configuration. The runtime credential must be separately approved and must not be a personal board key. Do not enter credentials in issue comments or source files.

The settings page offers **Enter token** and **Select existing secret**. Entered values are sent once through the worker action and stored through the native encrypted secret endpoint. The plugin config stores a native `secret_ref` object, never the value. Selection shows metadata only and accepts any active native provider. Initial saves leave sync disabled. Review the native secret reference and plugin binding before enabling sync. See the accepted task plan for full operator and rotation procedures.

The plugin accepts company destinations only in v0.1. It rejects user-secret destinations. The manifest job ticks every five minutes; company settings may select a cadence of five minutes or greater, rounded to the next tick.

## Sync and recovery

The worker fetches a complete source snapshot and the native destination inventory before it writes. It matches secrets by organization and Bitwarden secret UUID, so renames and project moves within the allowlist preserve the native secret ID, key, and bindings. Source revisions and native latest versions detect source changes and native value drift. Restart recovery uses deterministic destination keys and a non-value item journal; ambiguous rotation responses can result in one repeat version if the native version marker is unavailable.

Scope is a union of per-project entries in `bsmProjectSelections`: `{projectId, mode: "all"}` syncs every secret in the project (new ones included) and `{projectId, mode: "selected", secretIds: [...]}` syncs only those IDs. Empty selected lists, duplicates, malformed IDs, and IDs that are not listed in the organization are rejected on save (metadata check, no value read), and the worker fails closed on any invalid scope (never the whole organization). The older `bsmProjectIds` list still works and means whole-project; saving from the settings page migrates it, and setting both forms is rejected. The SDK list call returns no project; project membership is only returned with a value. The worker never reads values to learn membership: a whole-project entry fails closed with `project_membership_unavailable` unless the list reports each secret's project, and per-project secret discovery is unavailable for the same reason. Selected-only scopes fetch only the chosen IDs, and an ID that turns out to live outside its project is skipped at sync time. Withdrawing a project or secret from scope never archives, deletes, or reactivates its native secret.

Removal is opt-in. The worker archives only plugin-owned active secrets after two complete absences under an unchanged organization, project, source-ref, and key-prefix scope. An incomplete snapshot, failed apply, changed scope, or expired run budget suppresses removals. Archived reappearance is reported for operator handling; the worker does not reactivate stale values. Sync runs stop starting writes after four minutes and process at most 500 source IDs because the Bitwarden SDK does not expose pagination in the inspected contract.

## Disable and rotate

To stop activity, set `enabled` to `false` in the native plugin config. This does not delete or archive any native secrets. To rotate a runtime Paperclip key, pause the sync, create and save an approved replacement ref, update `paperclipApiToken` through the native config form, confirm the plugin binding, revoke the old key, and run an approved disposable check before enabling sync again. Do not replace the runtime ref with the temporary setup credential. To remove setup authority, delete `paperclipSetupApiToken` through the native config form, verify its plugin binding is gone, and revoke that credential. Token replacement creates a new bootstrap secret; the old one remains for operator cleanup.

## Security and runtime boundaries

- Native REST setup requests require the operator credential and a matching instance-admin identity. The worker does not mint credentials or use browser cookies.
- Runtime credentials are separate from setup credentials. Runtime never falls back to the setup ref.
- A board key retains all of its memberships. `requestedCompanyId` and plugin metadata do not narrow its authority. Keep live sync disabled until an authorized operator approves the credential and disposable destination.
- The Bitwarden native SDK makes its own network calls. Paperclip HTTP capability metadata does not contain or constrain that native networking.
- Secret values and bearer tokens must not enter logs, activity metadata, plugin state, persisted config, or package artifacts.
- The worker stores only non-value run status. Incomplete adapters or unavailable credentials must not be treated as a complete remote snapshot or authorize removals.

## Verified implementation constraints

- The current Paperclip CLI and plugin SDK are `2026.1005.0`.
- The published official Node dependency is `@bitwarden/sdk-napi@1.0.0`. The proposed `@bitwarden/sdk-secrets` package does not exist on npm.
- The Bitwarden SDK includes a native addon. It must remain a runtime dependency with its platform package, rather than being flattened into an ESM bundle. Loading and constructing a client has passed on Node 24 / Linux x64 GNU. Other platforms are unverified.
- Bootstrap credentials must be object-shaped `secret_ref` plugin settings, resolved at runtime through Paperclip. Plain secret-ID strings do not establish plugin bindings.
- Scheduled jobs have no company ID. The worker must enumerate companies and read each enabled company configuration explicitly.
- A five-minute manifest tick and a configurable due-time gate provide configurable cadence, rounded up to the next tick.
- Archive through PATCH with `status: "archived"`. DELETE marks secrets deleted and invokes provider deletion.
- The current native Secrets REST routes require board access. A secrets-only API scope is not available in the inspected CLI. Live setup needs an explicitly approved credential; development must not infer that approval.
- Company `secret_ref` and per-user `user_secret_ref` are different native paths. The latter requires native user-secret definitions and values owned by the authenticated user.

### Credential redaction verification

`npm test` captures stdout and stderr from the installed native SDK at Error level while it rejects a unique malformed fixture token before authentication or network access. The adapter fixture also supplies a synthetic raw SDK error containing unique token and secret-value markers and verifies that only a typed error code escapes. A runtime fixture sends a synthetic value through `ctx.http.fetch` and verifies it is absent from plugin state, activity, action results, and span records. The request itself necessarily contains its bearer header and value body at the host transport boundary.

The installed Paperclip SDK/server version (`2026.1005.0`) was also inspected locally. Its `plugin-sdk/dist/host-client-factory.js` forwards `http.fetch` parameters to the host HTTP service. The server's `dist/services/plugin-host-services.js` HTTP handler validates the destination and calls `executePinnedHttpRequest` without recording a span or logging request headers/body. This platform build therefore has no HTTP request-trace sink to capture for this path. These fixtures do not exercise successful Bitwarden authentication or prove behavior for every native SDK internal error; no live credential was used.
