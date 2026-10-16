import React, { useEffect, useRef, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { ERROR_CODES } from "../error-codes.js";
import { ALL_SECRETS_ID, NO_PROJECT_ID } from "../config.js";

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
  bsm_permission_denied: { title: "The Bitwarden machine account lacks access", action: "Give it read access to the projects you want to sync. After you fix it, turn sync off and on again to resume. Replacing the secret resumes sync automatically." },
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
  project_selection_invalid: { title: "The project selection is not valid", action: "Choose All secrets, or at least one project or secret." },
  project_selection_conflict: { title: "Two project lists are set", action: "Save the selection again from this page. It replaces the old list." },
  secret_selection_invalid: { title: "A selected secret was not found", action: "Load secrets again, uncheck the missing ones and save." },
  selected_project_missing: { title: "A selected project no longer exists", action: "Nothing was synced or removed. Open Scope, load secrets again and choose projects that still exist." },
  secret_limit_exceeded: { title: "The organization has more than 500 secrets", action: "The plugin supports up to 500. Reduce what the machine account can see, then load secrets again." },
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
/** Key names and ids only. The worker never sends a value, so none can be held or rendered here. */
export type Catalogue = {
  projects: { id: string; name: string | null; secretCount: number }[];
  secrets: { id: string; key: string; projectId: string }[];
  unselectable: { id: string; key: string }[];
};
/** Legacy `bsmProjectIds` is shown as whole-project entries; saving sends only the new form (explicit migration). */
export function selectionsFromConfig(config: Record<string, unknown>): { entries: SelectionEntry[]; legacy: boolean } {
  if (Array.isArray(config.bsmProjectSelections)) return { entries: config.bsmProjectSelections as SelectionEntry[], legacy: false };
  if (Array.isArray(config.bsmProjectIds)) return { entries: (config.bsmProjectIds as string[]).map((projectId) => ({ projectId, mode: "all" as const })), legacy: true };
  return { entries: [], legacy: false };
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const allSecretsSelected = (entries: readonly SelectionEntry[]) => entries.some((e) => same(e.projectId, ALL_SECRETS_ID));
export function selectionValid(entries: readonly SelectionEntry[]): boolean {
  const projects = new Set<string>();
  const ok = entries.length > 0 && entries.every((e) => {
    const key = e.projectId.toLowerCase();
    if (!uuid.test(e.projectId) || projects.has(key)) return false;
    projects.add(key);
    return e.mode === "all" || (e.mode === "selected" && e.secretIds.length > 0 && e.secretIds.every((id) => uuid.test(id)));
  });
  return ok && (!projects.has(ALL_SECRETS_ID) || entries.length === 1);
}
/** Mode switch: "all" replaces every entry; switching back starts from an empty choice. */
export function setAllSecrets(entries: readonly SelectionEntry[], on: boolean): SelectionEntry[] {
  return on ? [{ projectId: ALL_SECRETS_ID, mode: "all" }] : allSecretsSelected(entries) ? [] : [...entries];
}
/** A whole-project checkbox: selects every secret in the project, including ones added later. */
export function toggleProject(entries: readonly SelectionEntry[], projectId: string): SelectionEntry[] {
  if (allSecretsSelected(entries)) return [...entries];
  const key = projectId.toLowerCase();
  const current = entries.find((e) => same(e.projectId, projectId));
  if (current?.mode === "all") return entries.filter((e) => e !== current);
  return [...entries.filter((e) => !same(e.projectId, projectId)), { projectId: key, mode: "all" }];
}
/** An individual secret checkbox. In a whole-project selection the box is locked on, so this is a no-op there. */
export function toggleSecret(entries: readonly SelectionEntry[], projectId: string, secretId: string): SelectionEntry[] {
  if (allSecretsSelected(entries)) return [...entries];
  const current = entries.find((e) => same(e.projectId, projectId));
  if (current?.mode === "all") return [...entries];
  const id = secretId.toLowerCase();
  if (!current) return [...entries, { projectId: projectId.toLowerCase(), mode: "selected", secretIds: [id] }];
  const ids = current.secretIds.some((x) => same(x, id)) ? current.secretIds.filter((x) => !same(x, id)) : [...current.secretIds, id];
  return ids.length === 0 ? entries.filter((e) => e !== current) : entries.map((e) => e === current ? { ...current, secretIds: ids } : e);
}
export const projectChecked = (entries: readonly SelectionEntry[], projectId: string) =>
  allSecretsSelected(entries) || entries.some((e) => same(e.projectId, projectId) && e.mode === "all");
export const secretChecked = (entries: readonly SelectionEntry[], projectId: string, secretId: string) =>
  projectChecked(entries, projectId) || entries.some((e) => same(e.projectId, projectId) && e.mode === "selected" && e.secretIds.some((x) => same(x, secretId)));
/** "N secrets from M projects", counted against the loaded catalogue. `unknown` = saved choices not in it. */
export function selectionSummary(entries: readonly SelectionEntry[], catalogue: Catalogue | null) {
  if (!catalogue) return { secrets: null, projects: null, unknown: 0 };
  if (allSecretsSelected(entries)) return { secrets: catalogue.secrets.length, projects: catalogue.projects.filter((p) => p.secretCount > 0).length, unknown: 0 };
  let secrets = 0, projects = 0, unknown = 0;
  for (const e of entries) {
    const inProject = catalogue.secrets.filter((s) => same(s.projectId, e.projectId));
    if (e.mode === "all") { secrets += inProject.length; projects++; continue; }
    const hit = e.secretIds.filter((id) => inProject.some((s) => same(s.id, id))).length;
    secrets += hit; unknown += e.secretIds.length - hit; if (hit > 0) projects++;
  }
  return { secrets, projects, unknown };
}
export const projectLabel = (p: { id: string; name: string | null }) => same(p.id, NO_PROJECT_ID) ? "No project" : p.name ?? `Project ${p.id.slice(0, 8)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function SecretTree({ catalogue, entries, onChange }: { catalogue: Catalogue; entries: readonly SelectionEntry[]; onChange: (next: SelectionEntry[]) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = catalogue.projects.filter((p) => p.secretCount > 0 || projectChecked(entries, p.id));
  return <div>
    {groups.length === 0 && <p role="note">This organization has no secrets visible to this token.</p>}
    {groups.map((p) => {
      const key = p.id.toLowerCase(), label = projectLabel(p), secrets = catalogue.secrets.filter((s) => same(s.projectId, p.id));
      const chosen = secrets.filter((s) => secretChecked(entries, p.id, s.id)).length, expanded = open[key] === true;
      return <div className="card" key={key}>
        <div className="group-head">
          <label className="inline-control"><input type="checkbox" checked={projectChecked(entries, p.id)} onChange={() => onChange(toggleProject(entries, p.id))} aria-describedby={`count-${key}`} /> <strong>{label}</strong></label>
          <span id={`count-${key}`}>{plural(secrets.length, "secret")} · {chosen} selected</span>
          <button type="button" aria-expanded={expanded} aria-controls={`secrets-${key}`} onClick={() => setOpen((o) => ({ ...o, [key]: !expanded }))}>{expanded ? "Hide" : "Show"} secrets<span className="sr-only"> in {label}</span></button>
        </div>
        {projectChecked(entries, p.id) && <small>Whole project selected, including secrets added to it later.</small>}
        <ul id={`secrets-${key}`} hidden={!expanded} aria-label={`Secrets in ${label}`}>
          {secrets.map((s) => <li key={s.id}><label className="inline-control"><input type="checkbox" checked={secretChecked(entries, p.id, s.id)} disabled={projectChecked(entries, p.id)} onChange={() => onChange(toggleSecret(entries, p.id, s.id))} /> <span className="uuid">{s.key}</span></label></li>)}
        </ul>
      </div>;
    })}
    {catalogue.unselectable.length > 0 && <div className="card" role="note"><strong>{plural(catalogue.unselectable.length, "secret")} cannot be selected</strong>
      <p>Bitwarden did not report a project for these, so the plugin does not guess. They are not synced.</p>
      <ul aria-label="Secrets that cannot be selected">{catalogue.unselectable.map((s) => <li key={s.id} className="uuid">{s.key}</li>)}</ul></div>}
  </div>;
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
.bsm .group-head{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}.bsm .group-head .inline-control{flex:1 1 200px;min-width:0}.bsm ul{padding-left:20px;margin:8px 0}.bsm li{min-width:0;margin:4px 0}.bsm [hidden]{display:none}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
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
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null), [scopeNote, setScopeNote] = useState(""), scopeRef = useRef<HTMLHeadingElement>(null);
  const canDiscover = !!config.bsmAccessToken && !!String(config.bsmOrganizationId ?? "").match(uuid);
  const sum = selectionSummary(entries, catalogue);
  const errors = [status?.errorCode,status?.warningCode].filter(Boolean);
  const valid = !!config.bsmAccessToken && !!config.paperclipApiToken && !!String(config.bsmOrganizationId ?? "").match(uuid) &&
    selectionValid(entries) &&
    /^https:\/\//.test(String(config.paperclipApiOrigin ?? ""));
  const change = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const outgoingSettings = () => { const { bsmProjectIds: _legacy, ...rest } = config; return entries.length ? { ...rest, bsmProjectSelections: entries } : rest; };
  const discover = usePluginAction("discover-secrets");
  async function loadCatalogue() { setBusy(true); setMessage(""); setScopeNote("Loading secrets from Bitwarden…"); try { const r = await discover({}) as {ok:boolean;errorCode?:string} & Partial<Catalogue>; if (!r.ok) { setScopeNote(""); setMessage(r.errorCode ?? "setup_failed"); } else { setCatalogue({ projects: r.projects ?? [], secrets: r.secrets ?? [], unselectable: r.unselectable ?? [] }); setScopeNote(`Loaded ${plural((r.secrets ?? []).length, "secret")}.`); } } catch { setScopeNote(""); setMessage("setup_failed"); } finally { setBusy(false); } }
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
      <fieldset className="org-field" aria-describedby={fieldError==="bsmProjectSelections"||fieldError==="bsmProjectIds"?"projects-error":undefined}><legend>Secrets to sync</legend>
        {legacy&&<p role="note">This setting uses the older project list. It means <strong>all secrets in each project</strong>. Saving converts it to the new form and keeps each project selected as a whole.</p>}
        <p id="read-note"><strong>Loading secrets reads every secret value in this organization into the plugin worker's memory.</strong> This is intentional: Bitwarden only tells the plugin which project a secret belongs to together with its value. Values are discarded straight away. They are never shown, saved or logged. Only key names are listed here.</p>
        <button type="button" disabled={busy||!canDiscover} aria-describedby="find-hint read-note" onClick={()=>void loadCatalogue()}>{catalogue?"Reload secrets":"Load secrets"}</button><small id="find-hint">Uses the saved credential and organization. Save the credential first.</small>
        <div role="status" aria-live="polite">{scopeNote}</div>
        <div role="radiogroup" aria-label="Which secrets to sync" className="grid">
          <label className="radio-option"><input type="radio" name="scope-mode" checked={allSecretsSelected(entries)} onChange={()=>setEntries(setAllSecrets(entries,true))} />All secrets (including future ones)</label>
          <label className="radio-option"><input type="radio" name="scope-mode" checked={!allSecretsSelected(entries)} onChange={()=>setEntries(setAllSecrets(entries,false))} />Choose projects or secrets</label></div>
        {!allSecretsSelected(entries)&&(catalogue?<SecretTree catalogue={catalogue} entries={entries} onChange={setEntries} />:<p role="note">{entries.length===0?"Nothing chosen yet. Load secrets, then tick whole projects or single secrets.":`${plural(entries.filter((e)=>e.mode==="all").length,"whole project")} and ${plural(entries.reduce((n,e)=>n+(e.mode==="selected"?e.secretIds.length:0),0),"individual secret")} saved. Load secrets to review them.`}</p>)}
        <p role="status" aria-live="polite" id="scope-summary"><strong>{allSecretsSelected(entries)?(sum.secrets===null?"All secrets in the organization will sync.":`${plural(sum.secrets,"secret")} from ${plural(sum.projects ?? 0,"project")} will sync (all secrets, including future ones).`):sum.secrets===null?(entries.length?"Load secrets to see the count.":"No secrets chosen."):`${plural(sum.secrets,"secret")} from ${plural(sum.projects ?? 0,"project")} will sync.${sum.unknown?` ${plural(sum.unknown,"saved secret")} not found in Bitwarden.`:""}`}</strong></p>
        {(fieldError==="bsmProjectSelections"||fieldError==="bsmProjectIds")&&<small id="projects-error">Check the selection: choose All secrets, or at least one project or secret.</small>}
      </fieldset>
      <label>Sync interval (minutes)<input type="number" min={5} value={Number(config.syncIntervalMinutes??15)} onChange={(e)=>change("syncIntervalMinutes",Number(e.target.value))} /></label>
      <label>Target key prefix<input value={String(config.targetSecretKeyPrefix??"bitwarden.")} onChange={(e)=>change("targetSecretKeyPrefix",e.target.value)} /></label>
      <label>Bitwarden region<select value={String(config.bitwardenRegion??"US")} onChange={(e)=>change("bitwardenRegion",e.target.value)}><option>US</option><option>EU</option></select></label>
      <label><span className="inline-control"><input type="checkbox" checked={config.archiveOnRemoval===true} onChange={(e)=>change("archiveOnRemoval",e.target.checked)} /> Allow archive after two complete missing snapshots</span></label>
    </div><p>Paperclip address: {String(config.paperclipApiOrigin??"Not set")}</p><button disabled={busy} onClick={()=>void save()}>Save settings</button><p className="muted">Saving turns sync off.</p></section>
    <section id="paperclip"><h2>3. Paperclip access</h2><p>Runtime credential: {config.paperclipApiToken ? "Configured" : "Not set"}.</p><p>Setup reference: {config.paperclipSetupApiToken ? "Configured" : "Not set — expected after setup"}.</p><p>Paperclip credentials are managed by an instance admin in the native plugin configuration. This page cannot edit them.</p></section>
    <section id="review"><h2>4. Review &amp; enable</h2><p>Status: <strong>{badge(status)}</strong>. Last run: {summary(status?.lastRunSummary)}</p><p>Review the secrets summary above. Sync runs on its schedule; this page does not start a run.</p><label><span className="inline-control"><input className="sync-switch" type="checkbox" role="switch" aria-label="Enable sync" aria-describedby={!valid?"enable-sync-hint":undefined} checked={config.enabled===true} disabled={busy||!valid} onChange={(e)=>void toggle(e.target.checked)} /> <span>Enable sync</span><strong aria-live="polite">{config.enabled===true?"On":"Off"}</strong></span></label>{!valid&&<p id="enable-sync-hint">Save valid settings first. Configure both credentials and choose what to sync before enabling sync.</p>}</section>
    {notice&&<p role="status">{notice}</p>}
  </main>;
}
function StatusCard({status}:{status:Status|null}) { return <section aria-label="Sync status"><h2>Status: {badge(status)}</h2><p>Last success: {stamp(status?.lastSuccessAt)} · Last attempt: {stamp(status?.lastAttemptAt)}</p><p>Next run: {stamp(status?.nextEligibleAt)}</p><p>Last run: {summary(status?.lastRunSummary)}</p></section>; }
