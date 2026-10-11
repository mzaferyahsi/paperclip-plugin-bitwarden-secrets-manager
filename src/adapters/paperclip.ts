import { AdapterError } from "./types.js";
import type {
  HttpRequest, HttpResponse, HttpTransport, NativeSecret, NativeSecretInput,
  PaperclipIdentity, SecretOwnership, SetupActor,
} from "./types.js";

const OWNER = "mzaferyahsi.bitwarden-secrets-manager-sync";

function safeSegment(value: string): string {
  if (!value || value.trim() !== value) throw new AdapterError("invalid_input");
  return encodeURIComponent(value);
}

function classifyStatus(status: number, writing: boolean): AdapterError {
  if (status === 401) return new AdapterError("paperclip_credential_expired_or_revoked");
  if (status === 403) return new AdapterError("paperclip_permission_denied");
  if (status === 429) return new AdapterError("paperclip_rate_limited", true);
  if (writing) return new AdapterError("ambiguous_write");
  return new AdapterError("paperclip_unavailable", status >= 500);
}

async function request(transport: HttpTransport, req: HttpRequest): Promise<unknown> {
  let response: HttpResponse;
  try {
    response = await transport(req);
  } catch {
    throw new AdapterError(req.method === "GET" ? "paperclip_unavailable" : "ambiguous_write", req.method === "GET");
  }
  if (response.status < 200 || response.status >= 300) {
    throw classifyStatus(response.status, req.method !== "GET");
  }
  try {
    return await response.json();
  } catch {
    throw new AdapterError(req.method === "GET" ? "paperclip_unavailable" : "ambiguous_write", req.method === "GET");
  }
}

function asSecrets(value: unknown, companyId: string): NativeSecret[] {
  if (!Array.isArray(value)) throw new AdapterError("snapshot_incomplete");
  return value.map(item => {
    if (!item || typeof item !== "object") throw new AdapterError("snapshot_incomplete");
    const row = item as Partial<NativeSecret>;
    if (typeof row.id !== "string" || !row.id || typeof row.companyId !== "string" ||
      typeof row.key !== "string" || typeof row.name !== "string" ||
      (row.status !== "active" && row.status !== "archived" && row.status !== "deleted")) {
      throw new AdapterError("snapshot_incomplete");
    }
    if (row.companyId !== companyId) throw new AdapterError("ownership_mismatch");
    return row as NativeSecret;
  });
}

export function sourceIdentityKey(orgId: string, secretId: string): string {
  return `bitwarden.${safeSegment(orgId)}.${safeSegment(secretId)}`;
}

export function ownershipMatches(secret: NativeSecret, orgId: string, sourceId: string): boolean {
  const metadata = secret.providerMetadata as Partial<SecretOwnership> | undefined;
  return metadata?.source === "bitwarden_secrets_manager" && metadata.syncOwner === OWNER &&
    metadata.bsmOrganizationId === orgId && metadata.bsmSecretId === sourceId && metadata.identityVersion === 1;
}

export class PaperclipSecretsAdapter {
  private inventory = new Map<string, NativeSecret>();

  constructor(private readonly transport: HttpTransport, private readonly companyId: string) {
    if (!companyId) throw new AdapterError("invalid_input");
  }

  async list(): Promise<NativeSecret[]> {
    const value = await request(this.transport, {
      method: "GET", path: `/api/companies/${safeSegment(this.companyId)}/secrets`,
    });
    const rows = asSecrets(value, this.companyId);
    if (Array.isArray(value) && rows.length !== value.length) throw new AdapterError("snapshot_incomplete");
    this.inventory = new Map(rows.map(row => [row.id, row]));
    return rows;
  }

  async create(input: NativeSecretInput): Promise<NativeSecret> {
    this.validateOwnedInput(input);
    const result = await request(this.transport, {
      method: "POST", path: `/api/companies/${safeSegment(this.companyId)}/secrets`, body: input,
    });
    if (!result || typeof result !== "object" || typeof (result as NativeSecret).id !== "string") {
      throw new AdapterError("ambiguous_write");
    }
    return result as NativeSecret;
  }

  async rotate(id: string, value: string): Promise<unknown> {
    this.requireOwnedTarget(id);
    if (!value.trim()) throw new AdapterError("invalid_input");
    return request(this.transport, { method: "POST", path: `/api/secrets/${safeSegment(id)}/rotate`, body: { value } });
  }

  async updateMetadata(id: string, name: string, providerMetadata: SecretOwnership): Promise<unknown> {
    this.requireOwnedTarget(id);
    this.validateOwnership(providerMetadata);
    if (!name.trim()) throw new AdapterError("invalid_input");
    return request(this.transport, { method: "PATCH", path: `/api/secrets/${safeSegment(id)}`, body: { name, providerMetadata } });
  }

  async archive(id: string): Promise<unknown> {
    this.requireOwnedTarget(id);
    return request(this.transport, { method: "PATCH", path: `/api/secrets/${safeSegment(id)}`, body: { status: "archived" } });
  }

  async reactivate(id: string): Promise<unknown> {
    this.requireOwnedTarget(id);
    return request(this.transport, { method: "PATCH", path: `/api/secrets/${safeSegment(id)}`, body: { status: "active" } });
  }

  private validateOwnedInput(input: NativeSecretInput): void {
    if (!input.name.trim() || !input.key || input.key.length > 120 || !input.value.trim() ||
      input.provider !== "local_encrypted" || input.managedMode !== "paperclip_managed") {
      throw new AdapterError("invalid_input");
    }
    this.validateOwnership(input.providerMetadata);
  }

  private requireOwnedTarget(id: string): NativeSecret {
    const target = this.inventory.get(id);
    const metadata = target?.providerMetadata as Partial<SecretOwnership> | undefined;
    if (!target || target.companyId !== this.companyId || metadata?.source !== "bitwarden_secrets_manager" ||
      metadata.syncOwner !== OWNER || metadata.identityVersion !== 1 || !metadata.bsmOrganizationId || !metadata.bsmSecretId) {
      throw new AdapterError("ownership_mismatch");
    }
    return target;
  }

  private validateOwnership(metadata: SecretOwnership): void {
    if (metadata.source !== "bitwarden_secrets_manager" || metadata.syncOwner !== OWNER || metadata.identityVersion !== 1 ||
      !metadata.bsmOrganizationId || !metadata.bsmSecretId || !metadata.bsmProjectId || !metadata.sourceRevision) {
      throw new AdapterError("ownership_mismatch");
    }
  }
}

/** Setup routes use only the transient, identity-bound instance-admin credential. */
export async function assertSetupIdentity(
  actor: SetupActor,
  identity: PaperclipIdentity,
): Promise<void> {
  if (actor.type !== "user" || !actor.userId || !actor.companyId || identity.userId !== actor.userId ||
    !identity.isInstanceAdmin || !identity.companyIds.includes(actor.companyId)) {
    throw new AdapterError("identity_mismatch");
  }
}

export async function listSelectableSecrets(
  transport: HttpTransport,
  actor: SetupActor,
  identity: PaperclipIdentity,
): Promise<Array<Pick<NativeSecret, "id" | "name" | "companyId" | "status">>> {
  await assertSetupIdentity(actor, identity);
  const value = await request(transport, {
    method: "GET", path: `/api/companies/${safeSegment(actor.companyId)}/secrets`,
  });
  return asSecrets(value, actor.companyId)
    .filter(secret => secret.status === "active")
    .map(({ id, name, companyId, status }) => ({ id, name, companyId, status }));
}

export async function createBootstrapTokenSecret(
  transport: HttpTransport,
  actor: SetupActor,
  identity: PaperclipIdentity,
  input: { name: string; key: string; value: string },
): Promise<Pick<NativeSecret, "id" | "name" | "key" | "companyId">> {
  await assertSetupIdentity(actor, identity);
  if (!input.value.trim() || !input.name.trim() || !input.key.startsWith("bitwarden.bootstrap.")) {
    throw new AdapterError("invalid_input");
  }
  const created = await request(transport, {
    method: "POST", path: `/api/companies/${safeSegment(actor.companyId)}/secrets`,
    body: { name: input.name, key: input.key, provider: "local_encrypted", managedMode: "paperclip_managed", value: input.value },
  });
  if (!created || typeof created !== "object" || typeof (created as NativeSecret).id !== "string") {
    throw new AdapterError("ambiguous_write");
  }
  const { id, name, key, companyId } = created as NativeSecret;
  return { id, name, key, companyId };
}

export async function savePluginConfig(
  transport: HttpTransport,
  actor: SetupActor,
  identity: PaperclipIdentity,
  pluginId: string,
  settings: Record<string, unknown>,
  bsmRef: { type: "secret_ref"; secretId: string; version: "latest" },
): Promise<void> {
  await assertSetupIdentity(actor, identity);
  if (!bsmRef.secretId || bsmRef.type !== "secret_ref") throw new AdapterError("invalid_input");
  const secrets = await request(transport, {
    method: "GET", path: `/api/companies/${safeSegment(actor.companyId)}/secrets`,
  });
  const refSecret = asSecrets(secrets, actor.companyId).find(secret => secret.id === bsmRef.secretId);
  if (!refSecret || refSecret.status !== "active") throw new AdapterError("ownership_mismatch");
  await request(transport, {
    method: "POST", path: `/api/plugins/${safeSegment(pluginId)}/config`,
    body: { companyId: actor.companyId, configJson: { ...settings, bsmAccessToken: bsmRef } },
  });
}
