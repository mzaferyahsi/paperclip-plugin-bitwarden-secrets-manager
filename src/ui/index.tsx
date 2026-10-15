import React, { useEffect, useRef, useState } from "react";
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
  paperclip_credential_expired_or_revoked: { title: "Paperclip rejected the runtime credential", action: "Replace the runtime credential in the native plugin config. After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
  paperclip_credential_required: { title: "The Paperclip runtime credential is missing", action: "Set the runtime credential in the native plugin config (step 3)." },
  bsm_credential_required: { title: "The Bitwarden credential is missing", action: "Open step 1 and add the machine-account token." },
  bsm_credential_rejected: { title: "Bitwarden rejected the machine-account token", action: "Replace the Bitwarden token (step 1). After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
  bsm_permission_denied: { title: "The Bitwarden machine account lacks access", action: "Give it read access to the selected projects. After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
  paperclip_permission_denied: { title: "The Paperclip credential lacks permission", action: "Check the runtime credential's access. After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
  identity_mismatch: { title: "The runtime credential belongs to another identity", action: "Use the credential created for this plugin." },
  configuration_required: { title: "Settings need a fix", action: "Correct the highlighted field. After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
  credential_cooldown: { title: "Sync is paused after a credential error", action: "After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
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
  project_selection_invalid: { title: "The project selection is not valid", action: "Choose at least one project, and at least one secret for each selected-secrets project." },
  project_selection_conflict: { title: "Two project lists are set", action: "Save the selection again from this page. It replaces the old list." },
  secret_selection_invalid: { title: "A selected secret is not in its project", action: "Reload the secret list for that project and tick the secrets again." },
  selection_unverified: { title: "The selection could not be checked", action: "Nothing was saved. Press Test connection, then save again." },
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

export type SelectionEntry = { projectId: string; mode: "all" } | { projectId: string; mode: "selected"; secretIds: string[] };
/** Legacy `bsmProjectIds` is shown as whole-project entries; saving sends only the new form (explicit migration). */
export function selectionsFromConfig(config: Record<string, unknown>): { entries: SelectionEntry[]; legacy: boolean } {
  if (Array.isArray(config.bsmProjectSelections)) return { entries: config.bsmProjectSelections as SelectionEntry[], legacy: false };
  if (Array.isArray(config.bsmProjectIds)) return { entries: (config.bsmProjectIds as string[]).map((projectId) => ({ projectId, mode: "all" as const })), legacy: true };
  return { entries: [], legacy: false };
}
export function selectionValid(entries: readonly SelectionEntry[]): boolean {
  const projects = new Set<string>();
  return entries.length > 0 && entries.every((e) => {
    const key = e.projectId.toLowerCase();
    if (!uuid.test(e.projectId) || projects.has(key)) return false;
    projects.add(key);
    return e.mode === "all" || (e.mode === "selected" && e.secretIds.length > 0 && e.secretIds.every((id) => uuid.test(id)));
  });
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function includeProject(entries: readonly SelectionEntry[], projectId: string): SelectionEntry[] {
  return entries.some((e) => same(e.projectId, projectId)) ? [...entries] : [...entries, { projectId: projectId.toLowerCase(), mode: "all" }];
}
export function excludeProject(entries: readonly SelectionEntry[], projectId: string): SelectionEntry[] { return entries.filter((e) => !same(e.projectId, projectId)); }
export function setProjectMode(entries: readonly SelectionEntry[], projectId: string, mode: "all" | "selected", restoreIds: readonly string[] = []): SelectionEntry[] {
  return entries.map((e) => !same(e.projectId, projectId) || e.mode === mode ? e : mode === "all" ? { projectId: e.projectId, mode } : { projectId: e.projectId, mode, secretIds: [...restoreIds] });
}
export function toggleSecret(entries: readonly SelectionEntry[], projectId: string, secretId: string): SelectionEntry[] {
  return entries.map((e) => !same(e.projectId, projectId) || e.mode !== "selected" ? e :
    { ...e, secretIds: e.secretIds.some((id) => same(id, secretId)) ? e.secretIds.filter((id) => !same(id, secretId)) : [...e.secretIds, secretId.toLowerCase()] });
}
const vars: React.CSSProperties = { color: "var(--foreground, #17202a)", background: "var(--background, #fff)", fontFamily: "inherit" };
const css = `
.bsm{max-width:780px;padding:20px;color:var(--foreground,#17202a);background:var(--background,#fff);font:inherit}
.bsm *{box-sizing:border-box}.bsm section,.bsm .card{border:1px solid var(--border,#697586);border-radius:10px;padding:16px;margin:14px 0}
.bsm label{display:grid;gap:6px;margin:12px 0}.bsm input,.bsm textarea,.bsm select{width:100%;max-width:560px;min-height:42px;padding:9px 11px;border:1px solid var(--border,#596579);border-radius:6px;background:var(--background,#fff);color:var(--foreground,#17202a);font:inherit}
.bsm button,.bsm a,.bsm .radio-option{min-height:42px;display:inline-flex;align-items:center;padding:8px 12px;border-radius:6px;font:inherit}
.bsm button{border:1px solid var(--border,#596579);background:var(--background,#fff);color:var(--foreground,#17202a);cursor:pointer}.bsm button:disabled{opacity:.55;cursor:not-allowed}
.bsm .uuid{display:block;overflow-wrap:anywhere;opacity:.8}.bsm fieldset{min-width:0}.bsm h3{margin:0;font-size:1.05em}.bsm .inline-control{display:inline-flex;align-items:center;gap:10px}.bsm .inline-control input{width:24px;height:24px;min-height:24px;max-width:none;padding:0;margin:0;flex:0 0 24px}.bsm .grid{align-items:start}.bsm .org-field{grid-column:1/-1;min-width:0}.bsm .org-field input{min-width:0;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.bsm .radio-option{gap:8px;flex:1;border:1px solid var(--border,#596579);cursor:pointer}.bsm .radio-option input{width:18px;height:18px;min-height:18px;max-width:none;padding:0;margin:0}
.bsm :focus-visible{outline:3px solid var(--focus,#245bcc);outline-offset:2px}.bsm .badge{display:inline-block;border:1px solid currentColor;border-radius:99px;padding:4px 10px;font-weight:700}
.bsm .steps a[aria-current=step]{border-color:var(--focus,#245bcc);box-shadow:inset 0 -3px var(--focus,#245bcc);font-weight:700}.bsm .steps a[data-done=true]:before{content:"✓ ";font-weight:700}
.bsm .sync-switch{position:relative;width:48px!important;height:28px!important;min-height:28px!important;flex:0 0 48px!important;appearance:none;border:2px solid var(--border,#596579)!important;border-radius:99px!important;background:var(--muted,#e4e8ed)!important;cursor:pointer;transition:background .15s,border-color .15s}.bsm .sync-switch:before{content:"";position:absolute;width:20px;height:20px;left:2px;top:2px;border-radius:50%;background:var(--background,#fff);box-shadow:0 1px 3px #0005;transition:transform .15s}.bsm .sync-switch:checked{background:var(--accent,#245bcc)!important;border-color:var(--accent,#245bcc)!important}.bsm .sync-switch:checked:before{transform:translateX(20px)}.bsm .sync-switch:disabled{cursor:not-allowed}
.bsm .muted{color:var(--foreground,#17202a)}.bsm .error{border-left:4px solid var(--danger,#a32626)}.bsm .skeleton{height:14px;margin:12px 0;border-radius:5px;background:var(--muted,#e4e8ed);animation:bsm-pulse 1.2s ease-in-out infinite}
@keyframes bsm-pulse{50%{opacity:.45}}.bsm .steps{display:flex;gap:8px;flex-wrap:wrap}.bsm .steps a{border:1px solid var(--border,#596579);text-decoration:none;color:inherit}
.bsm .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.bsm .option[aria-checked=true]{background:var(--accent-subtle,#e9eef9);border-color:var(--focus,#245bcc)}
@media(max-width:500px){.bsm{padding:12px}.bsm .grid{grid-template-columns:1fr}.bsm .steps{display:grid;grid-template-columns:1fr 1fr}.bsm .steps a{justify-content:center}}
.bsm.widget{padding:0}.bsm.widget section{margin:0}.bsm.widget a{padding:0;text-decoration:underline;color:var(--link,var(--foreground,#17202a))}
`;
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString() : "Not yet";
const summary = (s?: Record<string, number> | null) => s ? Object.entries(s).map(([k,v]) => `${k}: ${v}`).join(" · ") : "No completed run yet";
function badge(status?: Status | null) {
  if (!status) return "Sync off";
  if (!status.configured || status.status === "setup_needed") return "Needs attention";
  if (!status.enabled) return "Sync off";
  if (status.status === "success" || status.status === "ok") return "Healthy";
  if (status.status === "partial" || status.status === "credential_cooldown") return "Partial · retrying";
  return "Needs attention";
}
const ErrorCard = ({ code }: { code?: string | null }) => { const copy = errorCopy(code); return copy ? <div className="card error" role="alert" tabIndex={-1}><strong>{copy.title}</strong><p>{copy.action}</p><small>{copy.code}</small></div> : null; };

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
  if (view.state === "loading") return <div className="bsm widget" style={vars}><style>{css}</style><section aria-label="Bitwarden sync loading"><span className="skeleton" /><span className="skeleton" /></section></div>;
  label = view.badge; line = view.line;
  return <div className="bsm widget" style={vars}><style>{css}</style><section aria-label="Bitwarden sync status"><strong className="badge">{label}</strong><p>{line}</p><a href={href}>Open settings</a></section></div>;
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
  const [activeStep, setActiveStep] = useState(1);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) errorRef.current?.querySelector<HTMLElement>("[role=alert]")?.focus(); }, [message]);
  const companyId = context.companyId;
  useEffect(() => { let alive = true; Promise.all([getStatus({}), getSettings({})]).then(([s,g]) => { if (!alive) return; setStatus(s as Status); const result = g as SettingsResult; if (!result.ok) setLocked(true); else setConfig(result.config ?? {}); }).catch(() => { if (alive) setLocked(true); }).finally(() => { if (alive) setLoaded(true); }); return () => { alive = false; }; }, []);
  const { entries, legacy } = selectionsFromConfig(config);
  const setEntries = (next: SelectionEntry[]) => setConfig((c) => { const { bsmProjectIds: _legacy, ...rest } = c; return { ...rest, bsmProjectSelections: next }; });
  const [found, setFound] = useState<{id:string;name:string|null}[]>([]), [projectSecrets, setProjectSecrets] = useState<Record<string,{id:string;key:string}[]>>({}), [manualProject, setManualProject] = useState(""), [stash, setStash] = useState<Record<string,string[]>>({}), [discovered, setDiscovered] = useState(false), [loadedSecrets, setLoadedSecrets] = useState<Record<string,boolean>>({}), [scopeNote, setScopeNote] = useState(""), scopeRef = useRef<HTMLHeadingElement>(null);
  const manualValid = uuid.test(manualProject), manualDuplicate = manualValid && entries.some((e) => same(e.projectId, manualProject));
  const canDiscover = !!config.bsmAccessToken && !!String(config.bsmOrganizationId ?? "").match(uuid);
  const errors = [status?.errorCode,status?.warningCode].filter(Boolean);
  const valid = !!config.bsmAccessToken && !!config.paperclipApiToken && !!String(config.bsmOrganizationId ?? "").match(uuid) &&
    selectionValid(entries) &&
    /^https:\/\//.test(String(config.paperclipApiOrigin ?? ""));
  const change = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const outgoingSettings = () => { const { bsmProjectIds: _legacy, ...rest } = config; return entries.length ? { ...rest, bsmProjectSelections: entries } : rest; };
  const discover = usePluginAction("discover-secrets");
  useEffect(() => { const next = entries.find((e) => e.mode === "selected" && !loadedSecrets[e.projectId.toLowerCase()]); if (next && !busy && loaded && !locked) void loadProjectSecrets(next.projectId); });
  async function discoverProjects() { setBusy(true); setMessage(""); try { const r = await discover({}) as {ok:boolean;errorCode?:string;projects?:{id:string;name:string|null}[]}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else { setFound(r.projects ?? []); setDiscovered(true); } } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  async function loadProjectSecrets(projectId: string) { setLoadedSecrets((m) => ({...m,[projectId.toLowerCase()]:true})); setBusy(true); setMessage(""); try { const r = await discover({projectId}) as {ok:boolean;errorCode?:string;secrets?:{id:string;key:string}[]|null}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else setProjectSecrets((m) => ({...m,[projectId.toLowerCase()]:r.secrets ?? []})); } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  async function save() {
    if (!companyId) { setMessage("Open this page from a company."); return; }
    setBusy(true); setMessage(""); setNotice(""); setFieldError("");
    try { const { bsmProjectIds: _legacy, ...outgoing } = config; const result = await saveSettings({ companyId, settings: { ...outgoing, bsmProjectSelections: entries } }) as {ok:boolean;errorCode?:string;field?:string|null}; if (!result.ok) { setFieldError(result.field ?? ""); setMessage(result.errorCode ?? "setup_failed"); return; }
      const fresh = await getSettings({}) as SettingsResult; if (fresh.ok) setConfig(fresh.config ?? {}); else setConfig((c) => ({ ...c, enabled: false })); setStatus((s) => s ? ({...s,enabled:false}) : s); setNotice("Settings saved. Saving turns sync off."); }
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
    try { const old = (config.bsmAccessToken as {secretId?:string}|null)?.secretId; const r = await saveToken({companyId,token,operationId:crypto.randomUUID(),settings:outgoingSettings()}) as {ok:boolean;errorCode?:string;secret?:{id?:string}};
      if (!r.ok) { setMessage(r.errorCode ?? "setup_failed"); return; }
      const fresh = await getSettings({}) as SettingsResult; if (fresh.ok) setConfig(fresh.config ?? {}); setNotice(old ? `Credential replaced. Previous secret ID: ${old}. Remove it from company secrets when safe. Sync remains off.` : "Credential saved. Sync remains off."); }
    catch { setMessage("setup_failed"); } finally { setToken(""); setBusy(false); }
  }
  async function loadSecrets() { setBusy(true); try { const r = await listSecrets({companyId}) as {ok:boolean;secrets?:{id:string;name:string;provider:string}[];errorCode?:string}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else setSecrets(r.secrets ?? []); } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  async function useSecret() { setBusy(true); setMessage(""); setNotice(""); const old=(config.bsmAccessToken as {secretId?:string}|null)?.secretId; try { const r = await selectSecret({companyId,secretId,settings:outgoingSettings()}) as {ok:boolean;errorCode?:string}; if (!r.ok) setMessage(r.errorCode ?? "setup_failed"); else { const fresh=await getSettings({}) as SettingsResult; if(fresh.ok)setConfig(fresh.config??{}); setNotice(old && old !== secretId ? `Credential replaced. Previous secret ID: ${old}. Remove it from company secrets when safe. Sync remains off.` : "Credential saved. Sync remains off."); } } catch { setMessage("setup_failed"); } finally { setBusy(false); } }
  if (settingsViewState(loaded, !locked) === "loading") return <main className="bsm" style={vars}><style>{css}</style><h1>Bitwarden Secrets Manager</h1><section aria-label="Loading settings"><div className="skeleton" /><div className="skeleton" /></section></main>;
  if (settingsViewState(loaded, !locked) === "locked") return <main className="bsm" style={vars}><style>{css}</style><h1>Bitwarden Secrets Manager</h1><StatusCard status={status} /><section><strong>Setup credential removed — settings locked (expected)</strong><p>To change settings, ask an instance admin to add the setup credential in the native plugin configuration.</p></section></main>;
  const code = message || errors[0] as string | undefined;
  return <main className="bsm" style={vars}><style>{css}</style><header><h1>Bitwarden Secrets Manager</h1><span className="badge">{badge(status)}</span></header>
    {message&&<div ref={errorRef} tabIndex={-1}><ErrorCard code={code} /></div>}
    <StatusCard status={status} />
    {errors.map((e) => <ErrorCard key={e} code={e} />)}
    <nav className="steps" aria-label="Setup steps">{[
      {id:"credential",label:"1. Bitwarden credential",done:!!config.bsmAccessToken},
      {id:"scope",label:"2. Scope",done:!!String(config.bsmOrganizationId??"").match(uuid)&&selectionValid(entries)},
      {id:"paperclip",label:"3. Paperclip access",done:!!config.paperclipApiToken},
      {id:"review",label:"4. Review & enable",done:false},
    ].map((step,index)=><a key={step.id} href={`#${step.id}`} aria-current={activeStep===index+1?"step":undefined} data-done={step.done} onClick={()=>setActiveStep(index+1)}>{step.label}</a>)}</nav>
    <section id="credential"><h2>1. Bitwarden credential</h2><p>Enter a machine-account token or select an existing company secret. The token value is never shown again.</p>
      <fieldset><legend>Credential method</legend><div className="grid">
        <label className="radio-option"><input type="radio" name="credential-method" value="enter" checked={mode==="enter"} onChange={()=>setMode("enter")} />Enter token</label><label className="radio-option"><input type="radio" name="credential-method" value="select" checked={mode==="select"} onChange={()=>setMode("select")} />Use existing secret</label></div></fieldset>
      {mode==="enter" ? <label>Machine-account token<input type="password" autoComplete="new-password" value={token} onChange={(e)=>setToken(e.target.value)} aria-describedby="token-help" /><small id="token-help">A replacement token is stored as an encrypted company secret.</small></label> : <><button type="button" disabled={busy} onClick={()=>void loadSecrets()}>Load secret metadata</button><label>Existing secret<select value={secretId} onChange={(e)=>setSecretId(e.target.value)}><option value="">Select an active secret</option>{secrets.map((s)=><option key={s.id} value={s.id}>{s.name} · {s.provider} · {s.id.slice(0,8)}</option>)}</select></label><button type="button" disabled={busy||!secretId} onClick={()=>void useSecret()}>Use selected secret</button></>}
      {mode==="enter"&&<><button type="button" aria-describedby={!token.trim()?"save-credential-hint":undefined} disabled={busy||!token.trim()} onClick={()=>void replaceToken()}>Save credential</button>{!token.trim()&&<small id="save-credential-hint">Enter a token first.</small>}</>}
    </section>
    <section id="scope"><h2 ref={scopeRef} tabIndex={-1}>2. Scope</h2><div className="grid">
      <label className="org-field">Organization UUID<input value={String(config.bsmOrganizationId??"")} aria-invalid={fieldError==="bsmOrganizationId"} aria-describedby={fieldError==="bsmOrganizationId"?"org-error":undefined} onChange={(e)=>change("bsmOrganizationId",e.target.value)} />{fieldError==="bsmOrganizationId"&&<small id="org-error">Enter a valid organization UUID.</small>}</label>
      <fieldset className="org-field" aria-describedby={fieldError==="bsmProjectSelections"||fieldError==="bsmProjectIds"?"projects-error":undefined}><legend>Projects and secrets to sync</legend>
        {legacy&&<p role="note">This setting uses the older project list. It means <strong>all secrets in each project</strong>, including new ones. Saving converts it to the new per-project selection without changing what syncs.</p>}
        <p>Pick a project, then sync all of its secrets (new ones included) or only the secrets you tick. Nothing outside this list is read for syncing.</p>
        <button type="button" disabled={busy||!canDiscover} aria-describedby="find-hint" onClick={()=>void discoverProjects()}>Find projects</button><small id="find-hint">Uses the saved credential and organization. Save the credential first.</small>
        <div role="status" aria-live="polite">{discovered&&(found.length===0?"No projects found for this organization and credential.":`${found.length} project${found.length===1?"":"s"} found.`)}</div>
        {found.length>0&&<ul aria-label="Projects found">{found.map((p)=>{ const on=entries.some((e)=>same(e.projectId,p.id)); return <li key={p.id}><label className="inline-control"><input type="checkbox" checked={on} onChange={(e)=>setEntries(e.target.checked?includeProject(entries,p.id):excludeProject(entries,p.id))} /> {p.name??"Unnamed project"} · {p.id.slice(0,8)}</label></li>; })}</ul>}
        <label>Add a project by UUID<input value={manualProject} aria-invalid={manualProject!==""&&!manualValid} aria-describedby="manual-hint" onChange={(e)=>setManualProject(e.target.value.trim())} /><small id="manual-hint">{manualProject===""?"":!manualValid?"Enter a project UUID (36 characters).":manualDuplicate?"Already added.":""}</small></label>
        <button type="button" disabled={!manualValid||manualDuplicate} onClick={()=>{ setEntries(includeProject(entries,manualProject)); setManualProject(""); }}>Add project</button>
        {entries.length===0&&<p>No project chosen yet. Choose at least one project.</p>}
        {entries.map((entry)=>{ const key=entry.projectId.toLowerCase(); const name=found.find((p)=>same(p.id,entry.projectId))?.name??"Project"; const list=projectSecrets[key]; const ids=entry.mode==="selected"?entry.secretIds:[]; const known=new Set((list??[]).map((x)=>x.id.toLowerCase()));
          return <div className="card" key={key}><fieldset><legend><h3>{name}</h3><small className="uuid">{entry.projectId}</small></legend>
          <div className="grid"><label className="radio-option"><input type="radio" name={`mode-${key}`} checked={entry.mode==="all"} onChange={()=>{ if(entry.mode==="selected") setStash((m)=>({...m,[key]:entry.secretIds})); setEntries(setProjectMode(entries,entry.projectId,"all")); }} />All secrets, including new ones</label>
          <label className="radio-option"><input type="radio" name={`mode-${key}`} checked={entry.mode==="selected"} onChange={()=>setEntries(setProjectMode(entries,entry.projectId,"selected",stash[key]??[]))} />Only selected secrets</label></div>
          {entry.mode==="selected"&&<><button type="button" disabled={busy} onClick={()=>void loadProjectSecrets(entry.projectId)}>Reload secret names</button>
            <div role="status" aria-live="polite">{busy&&!list?"Loading secret names…":list&&list.length===0?"This project has no secrets.":""}</div>
            <ul aria-label={`Secrets in ${name}`}>{[...new Map([...ids.map((id)=>[id.toLowerCase(),{id,key:list?.find((x)=>same(x.id,id))?.key??"Selected secret"}] as const),...(list??[]).map((x)=>[x.id.toLowerCase(),x] as const)]).values()].map((x)=>{ const missing=!!list&&!known.has(x.id.toLowerCase()); return <li key={x.id.toLowerCase()}><label className="inline-control"><input type="checkbox" checked={ids.some((id)=>same(id,x.id))} onChange={()=>setEntries(toggleSecret(entries,entry.projectId,x.id))} /> {x.key} · {x.id.slice(0,8)}{missing&&<small> Not found in this project. Untick it.</small>}</label></li>; })}</ul>
            {entry.secretIds.length===0&&<small>Tick at least one secret, or choose all secrets.</small>}</>}
          <button type="button" aria-label={`Remove project ${name}`} onClick={()=>{ setEntries(excludeProject(entries,entry.projectId)); setTimeout(()=>scopeRef.current?.focus(),0); }}>Remove project</button></fieldset></div>; })}
        {(fieldError==="bsmProjectSelections"||fieldError==="bsmProjectIds")&&<small id="projects-error">Check the project selection: each project needs all secrets or at least one ticked secret.</small>}
      </fieldset>
      <label>Sync interval (minutes)<input type="number" min={5} value={Number(config.syncIntervalMinutes??15)} onChange={(e)=>change("syncIntervalMinutes",Number(e.target.value))} /></label>
      <label>Target key prefix<input value={String(config.targetSecretKeyPrefix??"bitwarden.")} onChange={(e)=>change("targetSecretKeyPrefix",e.target.value)} /></label>
      <label>Bitwarden region<select value={String(config.bitwardenRegion??"US")} onChange={(e)=>change("bitwardenRegion",e.target.value)}><option>US</option><option>EU</option></select></label>
      <label><span className="inline-control"><input type="checkbox" checked={config.archiveOnRemoval===true} onChange={(e)=>change("archiveOnRemoval",e.target.checked)} /> Allow archive after two complete missing snapshots</span></label>
    </div><p>Paperclip address: {String(config.paperclipApiOrigin??"Not set")}</p><button disabled={busy} onClick={()=>void save()}>Save settings</button><p className="muted">Saving turns sync off.</p></section>
    <section id="paperclip"><h2>3. Paperclip access</h2><p>Runtime credential: {config.paperclipApiToken ? "Configured" : "Not set"}.</p><p>Setup reference: {config.paperclipSetupApiToken ? "Configured" : "Not set — expected after setup"}.</p><p>Paperclip credentials are managed by an instance admin in the native plugin configuration. This page cannot edit them.</p></section>
    <section id="review"><h2>4. Review &amp; enable</h2><p>Status: <strong>{badge(status)}</strong>. Last run: {summary(status?.lastRunSummary)}</p><p>Review the organization and project scope above. Sync runs on its schedule; this page does not start a run.</p><label><span className="inline-control"><input className="sync-switch" type="checkbox" role="switch" aria-label="Enable sync" aria-describedby={!valid?"enable-sync-hint":undefined} checked={config.enabled===true} disabled={busy||!valid} onChange={(e)=>void toggle(e.target.checked)} /> <span>Enable sync</span><strong aria-live="polite">{config.enabled===true?"On":"Off"}</strong></span></label>{!valid&&<p id="enable-sync-hint">Save valid settings first. Configure both credentials and the project scope before enabling sync.</p>}</section>
    {notice&&<p role="status">{notice}</p>}
  </main>;
}
function StatusCard({status}:{status:Status|null}) { return <section aria-label="Sync status"><h2>Status: {badge(status)}</h2><p>Last success: {stamp(status?.lastSuccessAt)} · Last attempt: {stamp(status?.lastAttemptAt)}</p><p>Next run: {stamp(status?.nextEligibleAt)}</p><p>Last run: {summary(status?.lastRunSummary)}</p></section>; }
