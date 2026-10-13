/** Stable, non-secret contracts shared by the source and Paperclip adapters. */
export type AdapterErrorCode =
  | "configuration_required"
  | "paperclip_credential_expired_or_revoked"
  | "paperclip_permission_denied"
  | "paperclip_rate_limited"
  | "paperclip_unavailable"
  | "remote_unavailable"
  | "snapshot_incomplete"
  | "identity_mismatch"
  | "ownership_mismatch"
  | "ambiguous_write"
  | "invalid_input";

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: AdapterErrorCode, retryable = false, retryAfterMs?: number) {
    super(code);
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface BsmSecret {
  id: string;
  organizationId: string;
  projectId: string | null;
  key: string;
  value: string;
  revisionDate: string;
  archived?: boolean;
}

export type SelectedBsmSecret = BsmSecret & { projectId: string };

export interface BsmSecretSummary {
  id: string;
  organizationId: string;
  projectId?: string;
}

export interface BsmSdk {
  listSecretIds(organizationId: string): Promise<readonly BsmSecretSummary[]>;
  getSecrets(ids: readonly string[]): Promise<readonly BsmSecret[]>;
  listProjects?(organizationId: string): Promise<readonly { id: string; organizationId: string; name?: string }[]>;
}

export interface BsmSnapshot {
  complete: boolean;
  secrets: readonly SelectedBsmSecret[];
  skippedCount: number;
}

export interface SecretRef {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
}

export interface SecretOwnership {
  source: "bitwarden_secrets_manager";
  syncOwner: "mzaferyahsi.bitwarden-secrets-manager-sync";
  bsmOrganizationId: string;
  bsmSecretId: string;
  bsmProjectId: string;
  sourceRevision: string;
  identityVersion: 1;
}

export interface NativeSecret {
  id: string;
  companyId: string;
  name: string;
  key: string;
  status: "active" | "archived" | "deleted";
  latestVersion?: number;
  providerMetadata?: Record<string, unknown>;
}

export interface NativeSecretInput {
  name: string;
  key: string;
  provider: "local_encrypted";
  managedMode: "paperclip_managed";
  value: string;
  providerMetadata: SecretOwnership;
}

export interface SetupActor {
  type: "user";
  userId: string;
  companyId: string;
}

export interface PaperclipIdentity {
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: readonly string[];
}

export interface HttpRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;
