import React, { useCallback, useEffect, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { describeCode } from "../messages.js";

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

type Overview = {
  ok: boolean; status: string; enabled: boolean;
  reason: { message: string; action: string } | null; error: { message: string; action: string } | null;
  credentials: { bitwardenToken: boolean; paperclipToken: boolean; paperclipSetupToken: boolean };
  scope: { organizationId: string | null; region: string; projects: { id: string; name: string | null }[]; intervalMinutes: number; archiveOnRemoval: boolean };
  lastSync: { attemptedAt: string | null; succeededAt: string | null; durationMs: number | null; result: string; counts: Record<string, number> | null };
  nextRunAt: string | null; checklist: { id: string; label: string; done: boolean }[]; config?: Settings;
};
const STATUS_LABEL: Record<string, string> = {
  disabled: "Sync is off", setup_needed: "Setup needed", blocked: "Blocked — action needed", error: "Last sync had errors", waiting: "Enabled — waiting for first run", ok: "Syncing normally",
};
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString() : "never";
const yesNo = (v: boolean) => v ? "yes" : "no";

export function BsmStatusWidget({ context }: { context: { companyId?: string | null } }) {
  const { data: worker } = usePluginData<{ status: string }>("worker-health");
  const getOverview = usePluginAction("get-overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => { void getOverview({}).then((r) => setOverview(r as Overview)).catch(() => setOverview(null)); }, [getOverview, context.companyId]);
  if (!worker) return <div>Bitwarden sync worker status is unavailable.</div>;
  if (!overview?.ok) return <section aria-label="Bitwarden sync status">Bitwarden sync: status unavailable</section>;
  return <section aria-label="Bitwarden sync status">
    <strong>{STATUS_LABEL[overview.status] ?? overview.status}</strong>
    <div>Last sync: {when(overview.lastSync.attemptedAt)}</div>
    <div>Next sync: {overview.nextRunAt ? when(overview.nextRunAt) : "not scheduled"}</div>
  </section>;
}

export function BsmSettingsPage({ context }: { context: { companyId?: string | null } }) {
  const companyId = context.companyId ?? undefined;
  const { data: worker } = usePluginData<{ status: string }>("worker-health");
  const getOverview = usePluginAction("get-overview");
  const testConnection = usePluginAction("test-connection");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [panel, setPanel] = useState("");
  const [testResult, setTestResult] = useState<null | { ok: boolean; projectCount?: number; secretCount?: number; projects?: { id: string; name: string | null; selected: boolean }[]; note?: string | null; error?: { message: string; action: string } | null }>(null);
  const [loaded, setLoaded] = useState(false);
  const listSecrets = usePluginAction("list-secrets");
  const saveToken = usePluginAction("save-token");
  const selectSecret = usePluginAction("select-secret");
  const saveSettings = usePluginAction("save-settings");
  const [mode, setMode] = useState<"enter" | "select">("enter");
  const [token, setToken] = useState("");
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<Settings>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  const refresh = useCallback(async () => {
    try {
      const result = await getOverview({}) as Overview;
      if (result.ok) { setOverview(result); if (result.config) setSettings((prior) => ({ ...result.config, ...prior })); }
      else setMessage(result.error?.action ?? "Settings are unavailable.");
    } catch { setMessage("Settings are unavailable."); }
    setLoaded(true);
  }, [getOverview]);
  useEffect(() => { if (companyId) void refresh(); }, [companyId, refresh]);
  async function runTest() {
    setPanel("Testing connection…"); setTestResult(null);
    try { const r = await testConnection({}) as NonNullable<typeof testResult>; setTestResult(r); setPanel(""); if (r.ok) void refresh(); }
    catch { setPanel("The connection test failed. Try again."); }
  }
  useEffect(() => () => setToken(""), []);
  function changeMode(next: "enter" | "select") { setToken(""); setMessage(""); setMode(next); }
  async function loadSecrets() {
    if (!companyId) return;
    setBusy(true); setMessage("");
    try {
      const result = await listSecrets({ companyId }) as { ok: boolean; secrets?: Secret[]; errorCode?: string };
      if (!result.ok) { const t = describeCode(result.errorCode ?? "setup_failed"); setMessage(`${t?.message} ${t?.action}`); return; }
      setSecrets(result.secrets ?? []);
      if (!result.secrets?.length) setMessage("No active company secrets are available to select.");
    } catch { setMessage("The request failed. Try again."); }
    finally { setBusy(false); }
  }
  async function persist() {
    const kind = mode === "enter" ? (token.trim() ? "enter" : "none") : (selectedId ? "select" : "none");
    if (!companyId) { setMessage("Open this page from a company."); return; }
    setBusy(true); setMessage("");
    try {
      const result = kind === "enter"
        ? await saveToken({ companyId, token, operationId, settings }) as { ok: boolean; errorCode?: string; secret?: { id: string }; secretId?: string }
        : kind === "select" ? await selectSecret({ companyId, secretId: selectedId, settings }) as { ok: boolean; errorCode?: string }
        : await saveSettings({ companyId, settings }) as { ok: boolean; errorCode?: string };
      if (!result.ok) {
        const failure = result as { secret?: { id?: string }; secretId?: string };
        const createdId = failure.secret?.id ?? failure.secretId;
        const text = describeCode(result.errorCode ?? "setup_failed");
        setMessage(`${text?.message} ${text?.action}${createdId ? ` Saved secret ID: ${createdId}` : ""}`);
        return;
      }
      setToken(""); setOperationId(crypto.randomUUID()); setSelectedId(""); setMessage("Saved. Sync remains disabled until you enable it in settings.");
      await refresh();
    } catch { setMessage("The request failed. Try again."); }
    finally { setBusy(false); }
  }
  const setField = (name: keyof Settings, value: unknown) => setSettings((prior) => ({ ...prior, [name]: value }));
  if (!loaded || !worker) return <div style={styles.page}>Loading settings…</div>;
  return <main style={styles.page}>
    <h1>Bitwarden Secrets Manager</h1>
    <section style={styles.section} aria-label="Status">
      <h2>{STATUS_LABEL[overview?.status ?? ""] ?? "Status"}</h2>
      {(overview?.reason || overview?.error) && <p role="alert"><strong>{(overview.reason ?? overview.error)!.message}</strong><br />{(overview.reason ?? overview.error)!.action}</p>}
      <h3>Credentials</h3>
      <ul><li>Bitwarden machine access token: {yesNo(overview?.credentials.bitwardenToken ?? false)}</li><li>Paperclip API token: {yesNo(overview?.credentials.paperclipToken ?? false)}</li></ul>
      <h3>Scope</h3>
      <ul><li>Organization: {overview?.scope.organizationId ?? "not set"}</li><li>Region: {overview?.scope.region}</li>
        <li>Projects: {overview?.scope.projects.length ? overview.scope.projects.map((p) => `${p.name ? `${p.name} · ` : ""}${p.id}`).join("; ") : "none selected"}</li></ul>
      <h3>Last sync</h3>
      <ul><li>Time: {when(overview?.lastSync.attemptedAt)}{overview?.lastSync.durationMs != null ? ` (${Math.round(overview.lastSync.durationMs / 100) / 10} s)` : ""}</li>
        <li>Result: {overview?.lastSync.result}</li>
        <li>Counts: {overview?.lastSync.counts ? `read ${overview.lastSync.counts.read}, created ${overview.lastSync.counts.created}, updated ${overview.lastSync.counts.updated}, unchanged ${overview.lastSync.counts.unchanged}, archived ${overview.lastSync.counts.archived}, failed ${overview.lastSync.counts.failed}` : "no sync yet"}</li>
        <li>Next scheduled run: {overview?.nextRunAt ? when(overview.nextRunAt) : "not scheduled"}</li></ul>
      <p><button type="button" onClick={() => void runTest()}>Test connection</button></p>
      {panel && <p role="status">{panel}</p>}
      {testResult && (testResult.ok
        ? <div role="status"><p>Connection works. This token can see {testResult.projectCount} project(s) and {testResult.secretCount} secret(s).</p>
            {testResult.note && <p role="alert">{testResult.note}</p>}
            <ul>{testResult.projects?.map((p) => <li key={p.id}>{p.name ?? "(unnamed)"} · {p.id}{p.selected ? " · selected" : ""}</li>)}</ul></div>
        : <p role="alert"><strong>{testResult.error?.message}</strong><br />{testResult.error?.action}</p>)}
      <h3>Setup checklist</h3>
      <ol>{overview?.checklist.map((c) => <li key={c.id}>{c.done ? "✔ Done" : "☐ To do"} — {c.label}</li>)}</ol>
    </section>
    <p>One Save stores these settings and the machine access token (as a native encrypted secret). Sync stays disabled until you enable it.</p>
    <section style={styles.section}>
      <h2>Company sync settings</h2>
      <label style={styles.field}>Organization UUID<input style={styles.input} value={settings.bsmOrganizationId ?? ""} onChange={(e) => setField("bsmOrganizationId", e.target.value)} /></label>
      <label style={styles.field}>Project UUIDs (comma separated)<input style={styles.input} value={(settings.bsmProjectIds ?? []).join(", ")} onChange={(e) => setField("bsmProjectIds", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} /></label>
      <label style={styles.field}>Paperclip API origin<input style={styles.input} value={settings.paperclipApiOrigin ?? ""} placeholder="https://paperclip.example" onChange={(e) => setField("paperclipApiOrigin", e.target.value)} /></label>
      <p>Paperclip API token configured: <strong>{yesNo(overview?.credentials.paperclipToken ?? false)}</strong>. Setup token configured: <strong>{yesNo(overview?.credentials.paperclipSetupToken ?? false)}</strong> (needed only while saving; an instance admin binds both in the plugin configuration).</p>
      <label style={styles.field}>Sync interval in minutes<input style={styles.input} type="number" min={5} value={settings.syncIntervalMinutes ?? 15} onChange={(e) => setField("syncIntervalMinutes", Number(e.target.value))} /></label>
      <label style={styles.field}>Target key prefix<input style={styles.input} value={settings.targetSecretKeyPrefix ?? "bitwarden."} onChange={(e) => setField("targetSecretKeyPrefix", e.target.value)} /></label>
      <label style={styles.field}>Bitwarden region<select style={styles.input} value={settings.bitwardenRegion ?? "US"} onChange={(e) => setField("bitwardenRegion", e.target.value)}><option>US</option><option>EU</option></select></label>
      <label><input type="checkbox" checked={settings.archiveOnRemoval ?? false} onChange={(e) => setField("archiveOnRemoval", e.target.checked)} /> Allow archive after two complete missing snapshots</label>
      <h3>Bitwarden machine access token</h3>
      <p>Token configured: <strong>{yesNo(overview?.credentials.bitwardenToken ?? false)}</strong>. The value is never shown again; enter a new one to replace it.</p>
      <div role="group" aria-label="Credential method">
        <button type="button" aria-pressed={mode === "enter"} onClick={() => changeMode("enter")}>Enter token</button>{" "}
        <button type="button" aria-pressed={mode === "select"} onClick={() => changeMode("select")}>Select existing secret</button>
      </div>
      {mode === "enter" ? <label style={styles.field}>Machine access token<input style={styles.input} type="password" autoComplete="new-password" value={token} placeholder={overview?.credentials.bitwardenToken ? "Leave empty to keep the current token" : ""} onChange={(e) => setToken(e.target.value)} /></label> : <>
        <button type="button" disabled={busy} onClick={() => void loadSecrets()}>Load company secret metadata</button>
        <label style={styles.field}>Existing company secret<select style={styles.input} value={selectedId} onChange={(e) => setSelectedId(e.target.value)}><option value="">Select a secret</option>{secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name} · {secret.provider} · {secret.id}</option>)}</select></label>
      </>}
      <p><button type="button" disabled={busy} onClick={() => void persist()}>Save settings</button></p>
      {message && <p role="status">{message}</p>}
    </section>
  </main>;
}
