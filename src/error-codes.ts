/** One table of every code the worker can emit. The UI copy map must cover all of them (ADR-BSM-002 §5). */
export type Severity = "error" | "warning" | "info";
/** auto = the scheduler retries; blocked = no scheduled retry until the operator acts; none = action result only. */
export type RetryClass = "auto" | "blocked" | "none";

export const ERROR_CODES: Readonly<Record<string, { severity: Severity; retry: RetryClass }>> = {
  paperclip_credential_expired_or_revoked: { severity: "error", retry: "blocked" },
  paperclip_credential_required: { severity: "error", retry: "blocked" },
  bsm_credential_required: { severity: "error", retry: "blocked" },
  bsm_credential_rejected: { severity: "error", retry: "blocked" },
  bsm_permission_denied: { severity: "error", retry: "blocked" },
  paperclip_permission_denied: { severity: "error", retry: "blocked" },
  identity_mismatch: { severity: "error", retry: "blocked" },
  configuration_required: { severity: "error", retry: "blocked" },
  credential_cooldown: { severity: "warning", retry: "blocked" },
  ownership_mismatch: { severity: "error", retry: "blocked" },
  paperclip_rate_limited: { severity: "warning", retry: "auto" },
  remote_unavailable: { severity: "error", retry: "auto" },
  paperclip_unavailable: { severity: "error", retry: "auto" },
  native_request_failed: { severity: "error", retry: "auto" },
  snapshot_incomplete: { severity: "error", retry: "auto" },
  time_budget_exhausted: { severity: "warning", retry: "auto" },
  ambiguous_write: { severity: "warning", retry: "auto" },
  removal_scope_changed: { severity: "warning", retry: "auto" },
  archived_source_reappeared: { severity: "warning", retry: "none" },
  clock_anchor_reset: { severity: "warning", retry: "none" },
  sync_disabled: { severity: "info", retry: "none" },
  settings_invalid: { severity: "error", retry: "none" },
  organization_invalid: { severity: "error", retry: "none" },
  project_allowlist_invalid: { severity: "error", retry: "none" },
  project_selection_invalid: { severity: "error", retry: "none" },
  project_selection_conflict: { severity: "error", retry: "none" },
  secret_selection_invalid: { severity: "error", retry: "none" },
  selected_project_missing: { severity: "error", retry: "auto" },
  secret_limit_exceeded: { severity: "error", retry: "none" },
  selection_unverified: { severity: "error", retry: "none" },
  sync_interval_invalid: { severity: "error", retry: "none" },
  target_key_prefix_invalid: { severity: "error", retry: "none" },
  bitwarden_region_invalid: { severity: "error", retry: "none" },
  paperclip_origin_invalid: { severity: "error", retry: "none" },
  unsupported_destination_scope: { severity: "error", retry: "none" },
  token_required: { severity: "error", retry: "none" },
  secret_not_selectable: { severity: "error", retry: "none" },
  config_save_failed: { severity: "error", retry: "none" },
  operation_invalid: { severity: "error", retry: "none" },
  invalid_input: { severity: "error", retry: "none" },
  setup_credential_required: { severity: "info", retry: "none" },
  setup_credential_rejected: { severity: "error", retry: "none" },
  setup_permission_denied: { severity: "error", retry: "none" },
  setup_identity_mismatch: { severity: "error", retry: "none" },
  user_context_required: { severity: "error", retry: "none" },
  setup_failed: { severity: "error", retry: "none" },
};

/** Codes that stop scheduled retries until the operator changes a credential or setting. */
export const AUTHORIZATION_BLOCKED: ReadonlySet<string> = new Set([
  "paperclip_credential_expired_or_revoked", "paperclip_permission_denied", "configuration_required",
  "bsm_credential_rejected", "bsm_permission_denied",
]);
export const STATE_KEY = "runtime";
