# Paperclip Plugin: Bitwarden Secrets Manager Sync

Architecture and implementation are in preparation. This repository does not yet contain an installable plugin.

The plugin will mirror Bitwarden Secrets Manager values into Paperclip native secrets. It will use native assignment, versioning, usage and access-event mechanisms. It will not register a new native secret provider or modify the Paperclip server.

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

## Safety properties to implement

Use stable source UUIDs to preserve destination IDs through renames and project moves. Detect destination ownership before changing any secret. Fetch a complete remote snapshot before removal decisions. Default automatic archiving off. Record partial progress without persisting values. Never emit tokens, values, request bodies or raw SDK error messages to logs.

No live credentials, production installation or secret changes were used for this architectural check.
