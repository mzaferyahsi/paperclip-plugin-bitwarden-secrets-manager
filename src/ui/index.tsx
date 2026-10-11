import React, { useEffect, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";

type Ref = { type: "secret_ref"; secretId: string; version?: number | "latest" } | null;
type Settings = {
  enabled?: boolean; bsmAccessToken?: Ref; paperclipApiToken?: Ref; paperclipSetupApiToken?: Ref;
  bsmOrganizationId?: string; bsmProjectIds?: string[]; paperclipApiOrigin?: string;
  destinationScope?: string; syncIntervalMinutes?: number; targetSecretKeyPrefix?: string;
  archiveOnRemoval?: boolean; bitwardenRegion?: string;
};
type Secret = { id: string; name: string; key: string; provider: string; status: string };
const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 760, padding: 24, color: "var(--foreground, #222)", fontFamily: "inherit" },
  field: { display: "grid", gap: 6, margin: "14px 0" },
  input: { padding: "8px 10px", border: "1px solid #8886", borderRadius: 6, maxWidth: 520 },
  section: { border: "1px solid #8884", borderRadius: 8, padding: 16, marginTop: 16 },
};

export function BsmStatusWidget({ context }: { context: { companyId?: string | null } }) {
  const { data: worker } = usePluginData<{ status: string }>("worker-health");
  const getStatus = usePluginAction("get-status");
  const [status, setStatus] = useState<{ status: string; errorCode?: string | null; lastAttemptAt?: string | null } | null>(null);
  useEffect(() => { void getStatus({}).then((result) => setStatus(result as typeof status)).catch(() => setStatus({ status: "unavailable" })); }, [getStatus, context.companyId]);
  if (!worker) return <div>Bitwarden sync worker status is unavailable.</div>;
  return <section aria-label="Bitwarden sync status"><strong>Bitwarden sync: {status?.status ?? "loading"}</strong>{status?.errorCode && <div>Action: {status.errorCode}</div>}{status?.lastAttemptAt && <div>Last attempt: {status.lastAttemptAt}</div>}</section>;
}

export function BsmSettingsPage({ context }: { context: { companyId?: string | null } }) {
  const companyId = context.companyId ?? undefined;
  const { data: worker } = usePluginData<{ status: string }>("worker-health");
  const getSettings = usePluginAction("get-settings");
  const [loaded, setLoaded] = useState(false);
  const listSecrets = usePluginAction("list-secrets");
  const saveToken = usePluginAction("save-token");
  const selectSecret = usePluginAction("select-secret");
  const [mode, setMode] = useState<"enter" | "select">("enter");
  const [token, setToken] = useState("");
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<Settings>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!companyId) return;
    void getSettings({}).then((result) => {
      const response = result as { ok: boolean; config?: Settings };
      if (response.ok && response.config) setSettings(response.config);
      else setMessage("settings_unavailable");
      setLoaded(true);
    }).catch(() => { setMessage("settings_unavailable"); setLoaded(true); });
  }, [companyId, getSettings]);
  useEffect(() => () => setToken(""), []);
  function changeMode(next: "enter" | "select") { setToken(""); setMessage(""); setMode(next); }
  async function loadSecrets() {
    if (!companyId) return;
    setBusy(true); setMessage("");
    try {
      const result = await listSecrets({ companyId }) as { ok: boolean; secrets?: Secret[]; errorCode?: string };
      if (!result.ok) { setMessage(result.errorCode ?? "setup_failed"); return; }
      setSecrets(result.secrets ?? []);
      if (!result.secrets?.length) setMessage("No active company secrets are available to select.");
    } catch { setMessage("setup_failed"); }
    finally { setBusy(false); }
  }
  async function persist(kind: "enter" | "select") {
    if (!companyId) { setMessage("company_required"); return; }
    setBusy(true); setMessage("");
    try {
      const result = kind === "enter"
        ? await saveToken({ companyId, token, operationId, settings }) as { ok: boolean; errorCode?: string; secret?: { id: string }; secretId?: string }
        : await selectSecret({ companyId, secretId: selectedId, settings }) as { ok: boolean; errorCode?: string };
      if (!result.ok) {
        const failure = result as { secret?: { id?: string }; secretId?: string };
        const createdId = failure.secret?.id ?? failure.secretId;
        setMessage(`${result.errorCode ?? "setup_failed"}${createdId ? ` · saved secret ID: ${createdId}` : ""}`);
        return;
      }
      setToken(""); setOperationId(crypto.randomUUID()); setMessage("Saved. Sync remains disabled until you enable it in settings.");
      const latest = await getSettings({}) as { ok: boolean; config?: Settings };
      if (latest.ok && latest.config) setSettings(latest.config);
    } catch { setMessage("setup_failed"); }
    finally { setBusy(false); }
  }
  const setField = (name: keyof Settings, value: unknown) => setSettings((prior) => ({ ...prior, [name]: value }));
  if (!loaded || !worker) return <div style={styles.page}>Loading settings…</div>;
  return <main style={styles.page}>
    <h1>Bitwarden Secrets Manager</h1>
    <p>Choose how to bind the Bitwarden token. Secret values are never shown after saving.</p>
    <section style={styles.section}>
      <h2>Company sync settings</h2>
      <label style={styles.field}>Organization UUID<input style={styles.input} value={settings.bsmOrganizationId ?? ""} onChange={(e) => setField("bsmOrganizationId", e.target.value)} /></label>
      <label style={styles.field}>Project UUIDs (comma separated)<input style={styles.input} value={(settings.bsmProjectIds ?? []).join(", ")} onChange={(e) => setField("bsmProjectIds", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /></label>
      <label style={styles.field}>Paperclip API origin<input style={styles.input} value={settings.paperclipApiOrigin ?? ""} placeholder="https://paperclip.example" onChange={(e) => setField("paperclipApiOrigin", e.target.value)} /></label>
      <label style={styles.field}>Runtime Paperclip secret reference<input style={styles.input} value={settings.paperclipApiToken?.secretId ?? "Not configured"} readOnly /></label>
      <label style={styles.field}>Temporary setup secret reference<input style={styles.input} value={settings.paperclipSetupApiToken?.secretId ?? "Not configured"} readOnly /></label>
      <label style={styles.field}>Sync interval in minutes<input style={styles.input} type="number" min={5} value={settings.syncIntervalMinutes ?? 15} onChange={(e) => setField("syncIntervalMinutes", Number(e.target.value))} /></label>
      <label style={styles.field}>Target key prefix<input style={styles.input} value={settings.targetSecretKeyPrefix ?? "bitwarden."} onChange={(e) => setField("targetSecretKeyPrefix", e.target.value)} /></label>
      <label style={styles.field}>Bitwarden region<select style={styles.input} value={settings.bitwardenRegion ?? "US"} onChange={(e) => setField("bitwardenRegion", e.target.value)}><option>US</option><option>EU</option></select></label>
      <label><input type="checkbox" checked={settings.archiveOnRemoval ?? false} onChange={(e) => setField("archiveOnRemoval", e.target.checked)} /> Allow archive after two complete missing snapshots</label>
    </section>
    <section style={styles.section}>
      <h2>Bitwarden credential</h2>
      <div role="group" aria-label="Credential method">
        <button type="button" aria-pressed={mode === "enter"} onClick={() => changeMode("enter")}>Enter token</button>{" "}
        <button type="button" aria-pressed={mode === "select"} onClick={() => changeMode("select")}>Select existing secret</button>
      </div>
      {mode === "enter" ? <label style={styles.field}>Bitwarden machine token<input style={styles.input} type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} /></label> : <>
        <button type="button" disabled={busy} onClick={() => void loadSecrets()}>Load company secret metadata</button>
        <label style={styles.field}>Existing company secret<select style={styles.input} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">Select a secret</option>{secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name} · {secret.provider} · {secret.id}</option>)}</select></label>
      </>}
      <button type="button" disabled={busy || (mode === "enter" ? !token.trim() : !selectedId)} onClick={() => void persist(mode)}>Save credential reference</button>
      {message && <p role="status">{message}</p>}
    </section>
  </main>;
}
