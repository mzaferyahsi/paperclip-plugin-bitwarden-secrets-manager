import React, { useEffect, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { ERROR_CODES } from "../error-codes.js";

type Status = {
  status: string; enabled: boolean; configured: boolean; errorCode?: string | null; warningCode?: string | null;
  lastAttemptAt?: string | null; lastSuccessAt?: string | null; nextEligibleAt?: string | null;
  lastRunSummary?: Record<string, number> | null;
};
type Config = Record<string, unknown> & { enabled?: boolean; bsmAccessToken?: { secretId?: string } | null; paperclipSetupApiToken?: { secretId?: string } | null };
type SettingsResult = { ok: boolean; config?: Config; errorCode?: string };
type Copy = { title: string; action: string };

export const ERROR_COPY: Record<string, Copy> = {
  paperclip_credential_expired_or_revoked: { title: "Paperclip rejected the runtime credential", action: "Replace the runtime credential in the native plugin config." },
  paperclip_credential_required: { title: "The Paperclip runtime credential is missing", action: "Set the runtime credential in the native plugin config (step 3)." },
  bsm_credential_required: { title: "The Bitwarden credential is missing", action: "Open step 1 and add the machine-account token." },
  bsm_credential_rejected: { title: "Bitwarden rejected the machine-account token", action: "Replace the Bitwarden token (step 1)." },
  bsm_permission_denied: { title: "The Bitwarden machine account lacks access", action: "Give it read access to the selected projects." },
  paperclip_permission_denied: { title: "The Paperclip credential lacks permission", action: "Check the runtime credential's access." },
  identity_mismatch: { title: "The runtime credential belongs to another identity", action: "Use the credential created for this plugin." },
  configuration_required: { title: "Settings need a fix", action: "Correct the highlighted field." },
  credential_cooldown: { title: "Sync is paused after a credential error", action: "Fix the credential; sync resumes on the next run." },
  ownership_mismatch: { title: "A secret with this key or name exists but is not owned by the plugin", action: "Nothing was changed. Rename or remove the other secret." },
  paperclip_rate_limited: { title: "Paperclip is rate-limiting sync", action: "Nothing to do; sync retries automatically." },
  remote_unavailable: { title: "Bitwarden or Paperclip cannot be reached", action: "Nothing to do; check the provider status page if it continues." },
  paperclip_unavailable: { title: "Paperclip cannot be reached", action: "Nothing to do; sync retries automatically." },
  native_request_failed: { title: "A Paperclip request failed", action: "Nothing to do; sync retries automatically." },
  snapshot_incomplete: { title: "Bitwarden returned an incomplete list", action: "Nothing was archived; sync retries automatically." },
  time_budget_exhausted: { title: "Sync ran out of time", action: "Partial sync; it continues on the next run." },
  ambiguous_write: { title: "A write result was unclear", action: "Sync checks it again on the next run; nothing to do." },
  removal_scope_changed: { title: "The scope changed, so removal is paused", action: "Nothing was archived; removal resumes after two complete runs." },
  archived_source_reappeared: { title: "An archived secret came back in Bitwarden", action: "It was not restored. Review it in company secrets." },
  clock_anchor_reset: { title: "The schedule was reset", action: "Nothing to do." },
  sync_disabled: { title: "Sync is off", action: "Turn on Enable sync." },
  settings_invalid: { title: "Settings need a fix", action: "Correct the highlighted field." },
  organization_invalid: { title: "The organization ID is not valid", action: "Enter the Bitwarden organization UUID." },
  project_allowlist_invalid: { title: "A project ID is not valid", action: "Enter one project UUID per line." },
  sync_interval_invalid: { title: "The interval is not allowed", action: "Choose a value of at least 5 minutes." },
  target_key_prefix_invalid: { title: "The key prefix is not valid", action: "Use letters, digits, dots, dashes or underscores." },
  bitwarden_region_invalid: { title: "The region is not valid", action: "Choose US or EU." },
  paperclip_origin_invalid: { title: "The Paperclip address is not valid or cannot change now", action: "Use this instance's https address." },
  unsupported_destination_scope: { title: "That destination is not supported in v0.1", action: "Use company secrets." },
  token_required: { title: "Enter the token first", action: "Paste the machine-account token." },
  secret_not_selectable: { title: "That secret cannot be used", action: "Pick another active company secret." },
  config_save_failed: { title: "Settings were not saved", action: "Try again; nothing changed." },
  operation_invalid: { title: "The request was not valid", action: "Reload the page and try again." },
  invalid_input: { title: "The request was not valid", action: "Reload the page and try again." },
  setup_credential_required: { title: "Setup authority is not present", action: "Expected after setup. Add a setup ref to change settings." },
  setup_credential_rejected: { title: "Paperclip rejected the setup credential", action: "Replace the setup credential in the native config." },
  setup_permission_denied: { title: "The setup credential is not an instance admin", action: "Use an instance-admin setup credential." },
  setup_identity_mismatch: { title: "The setup credential belongs to another user", action: "Use a setup credential for your own account." },
  user_context_required: { title: "Setup could not run", action: "Reload the page and try again." },
  setup_failed: { title: "Setup could not run", action: "Reload the page and try again." },
};
export function errorCopy(code?: string | null): Copy & { code: string } | null {
  if (!code) return null;
  return { code, ...(ERROR_COPY[code] ?? { title: "Something went wrong", action: "Check again later." }) };
}
export function copyCoverage(): string[] { return Object.keys(ERROR_CODES).filter((code) => !ERROR_COPY[code]); }

export function settingsViewState(loaded: boolean, settingsOk: boolean): "loading" | "locked" | "editable" {
  return !loaded ? "loading" : settingsOk ? "editable" : "locked";
}
export function widgetViewState(workerStatus: string | undefined, loaded: boolean, status?: Status | null) {
  if (workerStatus === "denied" || workerStatus === undefined || status?.status === "denied" || status?.status === "unavailable")
    return { state: "unavailable", badge: "Unavailable", line: "Bitwarden sync status is unavailable." };
  if (!loaded) return { state: "loading", badge: "", line: "" };
  if (!status?.configured) return { state: "not-set-up", badge: "Not set up", line: "Complete setup to start scheduled sync." };
  if (status.status === "success" || status.status === "ok") return { state: "healthy", badge: "Healthy", line: `Last success: ${stamp(status.lastSuccessAt)}.` };
  return { state: "error", badge: status.enabled ? "Needs attention" : "Sync off",
    line: status.errorCode ? (errorCopy(status.errorCode)?.title ?? "Sync needs attention.") : status.enabled ? "No successful run yet." : "Sync is turned off." };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const vars: React.CSSProperties = { color: "var(--foreground, #17202a)", background: "var(--background, #fff)", fontFamily: "inherit" };
const css = `
.bsm{max-width:780px;padding:20px;color:var(--foreground,#17202a);background:var(--background,#fff);font:inherit}
.bsm *{box-sizing:border-box}.bsm section,.bsm .card{border:1px solid var(--border,#697586);border-radius:10px;padding:16px;margin:14px 0}
.bsm label{display:grid;gap:6px;margin:12px 0}.bsm input,.bsm textarea,.bsm select{width:100%;max-width:560px;min-height:42px;padding:9px 11px;border:1px solid var(--border,#596579);border-radius:6px;background:var(--background,#fff);color:var(--foreground,#17202a);font:inherit}
.bsm button,.bsm a,.bsm [role=radio]{min-height:42px;display:inline-flex;align-items:center;padding:8px 12px;border-radius:6px}
.bsm button{border:1px solid var(--border,#596579);background:var(--background,#fff);color:var(--foreground,#17202a);cursor:pointer}.bsm button:disabled{opacity:.55;cursor:not-allowed}
.bsm :focus-visible{outline:3px solid var(--focus,#245bcc);outline-offset:2px}.bsm .badge{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:4px 10px;font-weight:700}
.bsm .muted{opacity:.78}.bsm .error{border-left:4px solid var(--danger,#a32626)}.bsm .skeleton{height:14px;margin:12px 0;border-radius:5px;background:var(--muted,#e4e8ed);animation:bsm-pulse 1.2s ease-in-out infinite}
@keyframes bsm-pulse{50%{opacity:.45}}.bsm .steps{display:flex;gap:8px;flex-wrap:wrap}.bsm .steps a{border:1px solid var(--border,#596579);text-decoration:none;color:inherit}
.bsm .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bsm .option[aria-checked=true]{background:var(--accent-subtle,#e9eef9);border-color:var(--focus,#245bcc)}
@media(max-width:500px){.bsm{padding:12px}.bsm .grid{grid-template-columns:1fr}.bsm .steps{display:grid;grid-template-columns:1fr 1fr}.bsm .steps a{justify-content:center}}
`;
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not yet";
const summary = (s?: Record<string, number> | null) => s ? Object.entries(s).map(([k,v]) => `${k}: ${v}`).join(" · ") : "No completed run yet";
function badge(status?: Status) {
  if (!status) return "Sync off";
  if (!status.configured || status.status === "setup_needed") return "Needs attention";
  if (!status.enabled) return "Sync off";
  if (status.status === "success" || status.status === "ok") return "Healthy";
  if (status.status === "partial" || status.status === "credential_cooldown") return "Partial · retrying";
  return "Needs attention";
}
const ErrorCard = ({ code }: { code?: string | null }) => { const copy = errorCopy(code); return copy ? <div className="card error" role="alert"><strong>{copy.title}</strong><p>{copy.action}</p><small>{copy.code}</small></div> : null; };

export function BsmStatusWidget({ context }: { context: { companyId?: string | null } }) {
  const { data: worker, loading: workerLoading, error: workerError } = usePluginData<{ status: string }>("worker-health");
  const getStatus = usePluginAction("get-status");
  const [status, setStatus] = useState<Status | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { let alive = true; void getStatus({}).then((r) => { if (alive) setStatus(r as Status); }).catch(() => { if (alive) setStatus({ status: "unavailable", enabled: false, configured: false }); }).finally(() => { if (alive) setLoaded(true); }); return () => { alive = false; }; }, []);
  const href = context.companyId ? `/companies/${context.companyId}/plugins` : "#";
  let label = "", line = "";
  const view = workerLoading ? { state: "loading", badge: "", line: "" } :
    workerError ? widgetViewState("denied", loaded, status) : widgetViewState(worker?.status, loaded, status);
  if (view.state === "loading") return <div className="bsm" style={vars}><style>{css}</style><section aria-label="Bitwarden sync loading"><span className="skeleton" /><span className="skeleton" /></section></div>;
  label = view.badge; line = view.line;
  return <div className="bsm" style={vars}><style>{css}</style><section aria-label="Bitwarden sync status"><strong className="badge">{label}</strong><p>{line}</p><a href={href}>Open settings</a></section></div>;
}

export function BsmSettingsPage({ context }: { context: { companyId?: string | null } }) {
  const getStatus = usePluginAction("get-status"), getSettings = usePluginAction("get-settings");
  const saveSettings = usePluginAction("save-settings"), setEnabled = usePluginAction("set-enabled");
  const saveToken = usePluginAction("save-token"), listSecrets = usePluginAction("list-secrets"), selectSecret = usePluginAction("select-secret");
  const [status, setStatus] = useState<Status | null>(null), [config, setConfig] = useState<Config>({});
  const [locked, setLocked] = useState(false), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [notice, setNotice] = useState(""), [fieldError, setFieldError] = useState(""), [token, setToken] = useState("");
  const [secrets, setSecrets] = useState<{id:string;name:string;provider:string}[]>([]), [secretId, setSecretId] = useState("");
  const [mode, setMode] = useState<"enter"|"select">("enter");
  const companyId = context.companyId;
  useEffect(() => { let alive = true; Promise.all([getStatus({}), getSettings({})]).then(([s,g]) => { if (!alive) return; setStatus(s as Status); const result = g as SettingsResult; if (!result.ok) setLocked(true); else setConfig(result.config ?? {}); }).catch(() => { if (alive) setLocked(true); }).finally(() => { if (alive) setLoaded(true); }); return () => { alive = false; }; }, []);
  const projects = Array.isArray(config.bsmProjectIds) ? (config.bsmProjectIds as string[]).join("\n") : "";
  const errors = [status?.errorCode,status?.warningCode].filter(Boolean);
  const valid = !!config.bsmAccessToken && !!config.paperclipApiToken && !!String(config.bsmOrganizationId ?? "").match(uuid) &&
    (config.bsmProjectIds as unknown[] | undefined)?.length && (config.bsmProjectIds as string[]).every((id) => uuid.test(id)) &&
    /^https:\/\//.test(String(config.paperclipApiOrigin ?? ""));
  const change = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  async function save() {
    if (!companyId) { setMessage("Open this page from a company."); return; }
    setBusy(true); setMessage(""); setNotice(""); setFieldError("");
    try { const result = await saveSettings({ companyId, settings: config }) as {ok:boolean;errorCode?:string;field?:string|null}; if (!result.ok) { setFieldError(result.field ?? ""); setMessage(result.errorCode ?? "setup_failed"); return; }
      setConfig((c) => ({ ...c, enabled: false })); setStatus((s) => s ? ({...s,enabled:false}) : s); setNotice("Settings saved. Saving turns sync off."); }
    catch { setMessage("setup_failed"); } finally { setBusy(false); }
  }
  async function toggle(enabled: boolean) {
    setBusy(true); setMessage("");
    try { const r = await setEnabled({ companyId, enabled }) as {ok:boolean;errorCode?:string}; if (!r.ok) { setMessage(r.errorCode ?? "setup_failed"); return; } setConfig((c) => ({...c,enabled})); setStatus((s) => s ? ({...s,enabled,status:enabled ? s.status : "disabled"}) : s); }
    catch { setMessage("setup_failed"); } finally { setBusy(false); }
  }
  async function replaceToken() {
    if (!companyId || !token.trim()) { setMessage("token_required"); return; }
    setBusy(true); setMessage(""); setNotice("");
    try { const old = (config.bsmAccessToken as {secretId?:string}|null)?.secretId; const r = await saveToken({companyId,token,operationId:crypto.randomUUID(),settings:config}) as {ok:boolean;errorCode?:string;secret?:{id?:string}};
      if (!r.ok) { setMessage(r.errorCode ?? "setup_failed"); return; }
      setToken(""); const fresh = await getSettings({}) as SettingsResult; if (fresh.ok) setConfig(fresh.config ?? {}); setNotice(old ? `Credential replaced. Previous secret ID: ${old}. Remove it from company secrets when safe. Sync remains off.` : "Credential saved. Sync remains off."); }
    catch { setMessage("setup_failed"); } finally { setBusy(false); }
  }
  async function loadSecrets() { setBusy(true); try { const r = await listSecrets({companyId}) as {ok:boolean;secrets?:{id:string;name:string;provider:string}[];errorCode?:string}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else setSecrets(r.secrets ?? []); } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  async function useSecret() { setBusy(true); setMessage(""); setNotice(""); const old=(config.bsmAccessToken as {secretId?:string}|null)?.secretId; try { const r = await selectSecret({companyId,secretId,settings:config}) as {ok:boolean;errorCode?:string}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else { const fresh=await getSettings({}) as SettingsResult; if(fresh.ok)setConfig(fresh.config??{}); setNotice(old && old !== secretId ? `Credential replaced. Previous secret ID: ${old}. Remove it from company secrets when safe. Sync remains off.` : "Credential saved. Sync remains off."); } } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  if (settingsViewState(loaded, !locked) === "loading") return <main className="bsm" style={vars}><style>{css}</style><h1>Bitwarden Secrets Manager</h1><section aria-label="Loading settings"><div className="skeleton" /><div className="skeleton" /></section></main>;
  if (settingsViewState(loaded, !locked) === "locked") return <main className="bsm" style={vars}><style>{css}</style><h1>Bitwarden Secrets Manager</h1><StatusCard status={status} /><section><strong>Setup credential removed — settings locked (expected)</strong><p>To change settings, ask an instance admin to add the setup credential in the native plugin configuration.</p></section></main>;
  const code = message || errors[0] as string | undefined;
  return <main className="bsm" style={vars}><style>{css}</style><header><h1>Bitwarden Secrets Manager</h1><span className="badge">{badge(status)}</span></header>
    <StatusCard status={status} />
    {errors.map((e) => <ErrorCard key={e} code={e} />)}
    <nav className="steps" aria-label="Setup steps"><a href="#credential">1. Bitwarden credential</a><a href="#scope">2. Scope</a><a href="#paperclip">3. Paperclip access</a><a href="#review">4. Review &amp; enable</a></nav>
    <section id="credential"><h2>1. Bitwarden credential</h2><p>Enter a machine-account token or select an existing company secret. The token value is never shown again.</p>
      <fieldset><legend>Credential method</legend><div className="grid" role="radiogroup" aria-label="Credential method">
        <button type="button" role="radio" aria-checked={mode==="enter"} className="option" onClick={()=>setMode("enter")}>Enter token</button><button type="button" role="radio" aria-checked={mode==="select"} className="option" onClick={()=>setMode("select")}>Use existing secret</button></div></fieldset>
      {mode==="enter" ? <label>Machine-account token<input type="password" autoComplete="new-password" value={token} onChange={(e)=>setToken(e.target.value)} aria-describedby="token-help" /><small id="token-help">A replacement token is stored as an encrypted company secret.</small></label> : <><button type="button" disabled={busy} onClick={()=>void loadSecrets()}>Load secret metadata</button><label>Existing secret<select value={secretId} onChange={(e)=>setSecretId(e.target.value)}><option value="">Select an active secret</option>{secrets.map((s)=><option key={s.id} value={s.id}>{s.name} · {s.provider} · {s.id.slice(0,8)}</option>)}</select></label><button type="button" disabled={busy||!secretId} onClick={()=>void useSecret()}>Use selected secret</button></>}
      {mode==="enter"&&<button type="button" disabled={busy||!token.trim()} onClick={()=>void replaceToken()}>Save credential</button>}
    </section>
    <section id="scope"><h2>2. Scope</h2><div className="grid">
      <label>Organization UUID<input value={String(config.bsmOrganizationId??"")} aria-invalid={fieldError==="bsmOrganizationId"} aria-describedby={fieldError==="bsmOrganizationId"?"org-error":undefined} onChange={(e)=>change("bsmOrganizationId",e.target.value)} />{fieldError==="bsmOrganizationId"&&<small id="org-error">Enter a valid organization UUID.</small>}</label>
      <label>Project UUIDs, one per line<textarea rows={4} value={projects} aria-invalid={fieldError==="bsmProjectIds"} aria-describedby={fieldError==="bsmProjectIds"?"projects-error":undefined} onChange={(e)=>change("bsmProjectIds",e.target.value.split(/\n/).map(x=>x.trim()).filter(Boolean))} />{fieldError==="bsmProjectIds"&&<small id="projects-error">Enter one valid project UUID per line.</small>}</label>
      <label>Sync interval (minutes)<input type="number" min={5} value={Number(config.syncIntervalMinutes??15)} onChange={(e)=>change("syncIntervalMinutes",Number(e.target.value))} /></label>
      <label>Target key prefix<input value={String(config.targetSecretKeyPrefix??"bitwarden.")} onChange={(e)=>change("targetSecretKeyPrefix",e.target.value)} /></label>
      <label>Bitwarden region<select value={String(config.bitwardenRegion??"US")} onChange={(e)=>change("bitwardenRegion",e.target.value)}><option>US</option><option>EU</option></select></label>
      <label><span><input type="checkbox" checked={config.archiveOnRemoval===true} onChange={(e)=>change("archiveOnRemoval",e.target.checked)} /> Allow archive after two complete missing snapshots</span></label>
    </div><p>Paperclip address: {String(config.paperclipApiOrigin??"Not set")}</p><button disabled={busy} onClick={()=>void save()}>Save settings</button><p className="muted">Saving turns sync off.</p></section>
    <section id="paperclip"><h2>3. Paperclip access</h2><p>Runtime credential: {config.paperclipApiToken ? "Configured" : "Not set"}.</p><p>Setup reference: {config.paperclipSetupApiToken ? "Configured" : "Not set — expected after setup"}.</p><p>Paperclip credentials are managed by an instance admin in the native plugin configuration. This page cannot edit them.</p></section>
    <section id="review"><h2>4. Review &amp; enable</h2><StatusCard status={status} /><p>Review the organization and project scope above. Sync runs on its schedule; this page does not start a run.</p><label><span><input type="checkbox" role="switch" aria-label="Enable sync" checked={config.enabled===true} disabled={busy||!valid} onChange={(e)=>void toggle(e.target.checked)} /> Enable sync</span></label>{!valid&&<p>Save valid settings and configure both credentials before enabling sync.</p>}</section>
    {message&&<ErrorCard code={code} />}{notice&&<p role="status">{notice}</p>}
  </main>;
}
function StatusCard({status}:{status:Status|null}) { return <section aria-label="Sync status"><h2>Status: {badge(status)}</h2><p>Last success: {stamp(status?.lastSuccessAt)} · Last attempt: {stamp(status?.lastAttemptAt)}</p><p>Next run: {stamp(status?.nextEligibleAt)}</p><p>Last run: {summary(status?.lastRunSummary)}</p></section>; }
