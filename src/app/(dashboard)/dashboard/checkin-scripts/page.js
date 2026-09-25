"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, ConfirmModal, Input, Modal, Select, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const API_URL = "/api/checkin-scripts";
const DEFAULT_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

const SAMPLE_SCRIPT = {
  name: "Example daily check-in",
  enabled: false,
  scheduleType: "cron",
  cronExpr: "0 8 * * *",
  timezone: DEFAULT_TIMEZONE,
  config: {
    url: "https://example.com/api/check-in",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer {{secret}}",
    },
    body: '{"date":"{{date}}"}',
    expectedStatus: [200],
    successPattern: "success|已签到|already",
    timeoutSeconds: 30,
  },
};

const EMPTY_FORM = {
  name: "",
  enabled: false,
  scheduleType: "manual",
  cronExpr: "0 8 * * *",
  timezone: DEFAULT_TIMEZONE,
  url: "",
  method: "GET",
  headersText: "{}",
  body: "",
  bodyOmitted: false,
  expectedStatusText: "200",
  successPattern: "",
  timeoutSeconds: 30,
  secret: "",
  secretAction: "keep",
};

function formFromScript(script) {
  if (!script) return { ...EMPTY_FORM, timezone: DEFAULT_TIMEZONE };
  return {
    name: script.name || "",
    enabled: script.enabled === true,
    scheduleType: script.scheduleType || "manual",
    cronExpr: script.cronExpr || "0 8 * * *",
    timezone: script.timezone || DEFAULT_TIMEZONE,
    url: script.config?.url || "",
    method: script.config?.method || "GET",
    headersText: JSON.stringify(script.config?.headers || {}, null, 2),
    body: script.config?.body || "",
    bodyOmitted: script.config?.bodyOmitted === true,
    expectedStatusText: (script.config?.expectedStatus || [200]).join(", "),
    successPattern: script.config?.successPattern || "",
    timeoutSeconds: script.config?.timeoutSeconds || 30,
    secret: "",
    secretAction: "keep",
  };
}

function buildPayload(form, enabledOverride) {
  const headers = JSON.parse(form.headersText || "{}");
  const expectedStatus = form.expectedStatusText.split(",").map((value) => Number(value.trim())).filter(Number.isInteger);
  return {
    name: form.name,
    enabled: enabledOverride === undefined ? form.enabled : enabledOverride,
    scheduleType: form.scheduleType,
    cronExpr: form.cronExpr,
    timezone: form.timezone,
    config: {
      url: form.url,
      method: form.method,
      headers,
      body: form.body,
      bodyOmitted: form.bodyOmitted === true,
      expectedStatus,
      successPattern: form.successPattern,
      timeoutSeconds: Number(form.timeoutSeconds),
    },
    secret: form.secret,
    secretAction: form.secretAction,
  };
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Never" : date.toLocaleString();
}

function statusVariant(status) {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed_out") return "error";
  if (status === "running" || status === "queued") return "warning";
  return "default";
}

function statusLabel(status) {
  return {
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
    timed_out: "Timed out",
    interrupted: "Interrupted",
  }[status] || "Unknown";
}

function FormModal({ isOpen, editing, form, saving, onClose, onChange, onSave, onUseExample, onClearSecret }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={editing ? "Edit Check-in Script" : "New Check-in Script"} size="xl">
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-xs text-text-muted">
          Declarative HTTP scripts run in an isolated request executor. Arbitrary JavaScript and shell commands are not accepted.
        </div>
        <Input label="Name" required value={form.name} onChange={(event) => onChange("name", event.target.value)} placeholder="Daily check-in" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select label="Schedule type" value={form.scheduleType} onChange={(event) => onChange("scheduleType", event.target.value)} options={[{ value: "manual", label: "Manual only" }, { value: "cron", label: "Cron schedule" }]} />
          {form.scheduleType === "cron" && <Input label="Cron expression" required value={form.cronExpr} onChange={(event) => onChange("cronExpr", event.target.value)} placeholder="0 8 * * *" hint="Five fields: minute hour day month weekday" />}
          <Input label="Timezone" value={form.timezone} onChange={(event) => onChange("timezone", event.target.value)} placeholder="Asia/Shanghai" />
          <Select label="Method" value={form.method} onChange={(event) => onChange("method", event.target.value)} options={["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => ({ value, label: value }))} />
        </div>
        <Input label="URL" required value={form.url} onChange={(event) => onChange("url", event.target.value)} placeholder="https://example.com/api/check-in" hint="Only public HTTP(S) targets are allowed. Redirects are not followed." />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-main" htmlFor="checkin-headers">Headers (JSON)</label>
            <textarea id="checkin-headers" value={form.headersText} onChange={(event) => onChange("headersText", event.target.value)} className="min-h-28 rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-xs text-text-main outline-none focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30" />
            <p className="text-xs text-text-muted">Use {'{{secret}}'} for Authorization, Cookie, or token headers.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-main" htmlFor="checkin-body">Request body</label>
            <textarea id="checkin-body" value={form.body} onChange={(event) => onChange("body", event.target.value)} className="min-h-28 rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-xs text-text-main outline-none focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30" placeholder={'{"date":"{{date}}"}'} />
            <p className="text-xs text-text-muted">{'{{date}}'} expands to YYYY-MM-DD at runtime.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Input label="Expected status" value={form.expectedStatusText} onChange={(event) => onChange("expectedStatusText", event.target.value)} placeholder="200, 201" />
          <Input label="Success pattern" value={form.successPattern} onChange={(event) => onChange("successPattern", event.target.value)} placeholder="success|already" hint="Optional regular expression" />
          <Input label="Timeout (seconds)" type="number" min="1" max="120" value={form.timeoutSeconds} onChange={(event) => onChange("timeoutSeconds", event.target.value)} />
        </div>
        <Input label="Secret" type="password" value={form.secret} onChange={(event) => onChange("secret", event.target.value)} placeholder={editing?.hasSecret ? "Leave blank to keep the saved secret" : "Token or cookie value"} hint="Stored encrypted with AUTOMATION_SECRET_KEY and never returned by the API." />
        {editing?.hasSecret && form.secretAction !== "clear" && <button type="button" onClick={onClearSecret} className="self-start text-xs font-medium text-red-500 hover:underline">Clear saved secret</button>}
        {form.secretAction === "clear" && <p className="text-xs text-red-500">The saved secret will be removed when you save.</p>}
        <Toggle checked={form.enabled} onChange={(value) => onChange("enabled", value)} label="Enabled" description="Enable the scheduled execution after saving." />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-4">
          <Button variant="outline" size="sm" onClick={onUseExample}>Use example</Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={onSave} loading={saving} disabled={!form.name.trim() || !form.url.trim()}>Save</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function RunsModal({ isOpen, script, runs, loading, onClose }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={script ? <><span>History</span> · {script.name}</> : <span>History</span>} size="lg">
      {loading ? <p className="text-sm text-text-muted">Loading...</p> : runs.length === 0 ? <p className="py-8 text-center text-sm text-text-muted">No runs yet.</p> : <div className="flex flex-col gap-2">{runs.map((run) => <div key={run.id} className="rounded-lg border border-border-subtle p-3"><div className="flex items-center justify-between gap-2"><Badge variant={statusVariant(run.status)} size="sm" dot>{statusLabel(run.status)}</Badge><span className="text-xs text-text-muted">{formatDateTime(run.finishedAt || run.queuedAt)}</span></div><p className="mt-2 text-sm text-text-main">{run.summary || run.errorMessage || "No summary"}</p><p className="mt-1 text-xs text-text-muted">{run.triggerType} · {run.durationMs != null ? `${run.durationMs}ms` : "—"} {run.httpStatus ? `· HTTP ${run.httpStatus}` : ""}</p></div>)}</div>}
    </Modal>
  );
}

export default function CheckinScriptsPage() {
  const [scripts, setScripts] = useState([]);
  const [runtime, setRuntime] = useState({ secretEncryption: false });
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editing, setEditing] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState(null);
  const [historyScript, setHistoryScript] = useState(null);
  const [runs, setRuns] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const notifySuccess = useNotificationStore((state) => state.success);
  const notifyError = useNotificationStore((state) => state.error);

  const loadScripts = useCallback(async () => {
    try {
      const response = await fetch(API_URL, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load scripts");
      setScripts(data.scripts || []);
      setRuntime(data.runtime || { secretEncryption: false });
    } catch (error) {
      notifyError(error.message || "Failed to load scripts");
    } finally {
      setLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    const timer = setTimeout(() => void loadScripts(), 0);
    return () => clearTimeout(timer);
  }, [loadScripts]);

  const loadRuns = useCallback(async (scriptId) => {
    setHistoryLoading(true);
    try {
      const response = await fetch(`${API_URL}/${scriptId}/runs`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to load history");
      setRuns(data.runs || []);
    } catch (error) {
      notifyError(error.message || "Failed to load history");
    } finally {
      setHistoryLoading(false);
    }
  }, [notifyError]);

  useEffect(() => {
    if (!historyScript) return undefined;
    const initial = setTimeout(() => void loadRuns(historyScript.id), 0);
    const timer = setInterval(() => void loadRuns(historyScript.id), 2500);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [historyScript, loadRuns]);

  const updateForm = (field, value) => setForm((current) => {
    if (field === "secret") {
      return { ...current, secret: value, secretAction: value ? "replace" : "keep" };
    }
    if (field === "body") {
      return { ...current, body: value, bodyOmitted: false };
    }
    return { ...current, [field]: value };
  });
  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, timezone: DEFAULT_TIMEZONE });
    setFormOpen(true);
  };
  const openEdit = (script) => {
    setEditing(script);
    setForm(formFromScript(script));
    setFormOpen(true);
  };
  const useExample = () => setForm(formFromScript(SAMPLE_SCRIPT));

  const saveScript = async () => {
    if (!password) {
      notifyError("Enter the operation password first");
      return;
    }
    setSaving(true);
    try {
      const payload = buildPayload(form);
      const response = await fetch(editing ? `${API_URL}/${editing.id}` : API_URL, {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json", "x-9r-password": password },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save script");
      notifySuccess(editing ? "Check-in script updated" : "Check-in script created");
      setFormOpen(false);
      await loadScripts();
    } catch (error) {
      notifyError(error.message || "Failed to save script");
    } finally {
      setSaving(false);
    }
  };

  const toggleScript = async (script) => {
    if (!password) {
      notifyError("Enter the operation password first");
      return;
    }
    try {
      const response = await fetch(`${API_URL}/${script.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-9r-password": password },
        body: JSON.stringify({ ...formFromScript(script), enabled: !script.enabled, secret: "", secretAction: "keep", config: script.config }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to update script");
      await loadScripts();
    } catch (error) {
      notifyError(error.message || "Failed to update script");
    }
  };

  const runScript = async (script) => {
    if (!password) {
      notifyError("Enter the operation password first");
      return;
    }
    setRunningId(script.id);
    try {
      const response = await fetch(`${API_URL}/${script.id}/run`, { method: "POST", headers: { "x-9r-password": password } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to start run");
      notifySuccess("Check-in run started");
      setHistoryScript(script);
    } catch (error) {
      notifyError(error.message || "Failed to start run");
    } finally {
      setRunningId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (!password) {
      notifyError("Enter the operation password first");
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`${API_URL}/${deleteTarget.id}`, { method: "DELETE", headers: { "x-9r-password": password } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to delete script");
      notifySuccess("Check-in script deleted");
      setDeleteTarget(null);
      await loadScripts();
    } catch (error) {
      notifyError(error.message || "Failed to delete script");
    } finally {
      setDeleting(false);
    }
  };

  const enabledCount = useMemo(() => scripts.filter((script) => script.enabled).length, [scripts]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-1 py-4 sm:px-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-main">Check-in Scripts</h1>
          <p className="mt-1 text-sm text-text-muted">Manage scheduled HTTP check-ins with safe, declarative scripts.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Operation password" aria-label="Operation password" className="w-48" />
          <Button onClick={openCreate} icon="add">New script</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card padding="sm"><p className="text-xs text-text-muted">Total scripts</p><p className="mt-1 text-2xl font-semibold">{scripts.length}</p></Card>
        <Card padding="sm"><p className="text-xs text-text-muted">Enabled</p><p className="mt-1 text-2xl font-semibold text-success">{enabledCount}</p></Card>
        <Card padding="sm"><p className="text-xs text-text-muted">Secret encryption</p><p className={`mt-1 text-sm font-semibold ${runtime.secretEncryption ? "text-success" : "text-warning"}`}>{runtime.secretEncryption ? "Available" : "Unavailable"}</p></Card>
      </div>
      {!runtime.secretEncryption && <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-xs text-text-muted">Set AUTOMATION_SECRET_KEY to a 32-byte base64 key before saving token or cookie secrets. Requests without a secret remain available.</div>}
      {loading ? <Card><p className="text-sm text-text-muted">Loading...</p></Card> : scripts.length === 0 ? <Card><div className="flex flex-col items-center gap-3 py-12 text-center"><span className="material-symbols-outlined text-4xl text-text-muted">event_available</span><p className="text-sm text-text-muted">No check-in scripts yet.</p><Button variant="outline" onClick={openCreate} icon="add">Create the first script</Button></div></Card> : <div className="flex flex-col gap-3">{scripts.map((script) => <Card key={script.id} padding="sm"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate font-semibold text-text-main">{script.name}</h2><Badge variant={script.enabled ? "success" : "default"} size="sm" dot>{script.enabled ? "enabled" : "disabled"}</Badge><Badge variant="default" size="sm">{script.scheduleType === "cron" ? script.cronExpr : "manual"}</Badge>{script.hasSecret && <Badge variant="info" size="sm">secret configured</Badge>}</div><p className="mt-1 truncate text-xs text-text-muted">{script.config?.method} {script.config?.url}</p><p className="mt-1 text-xs text-text-muted">Next: {formatDateTime(script.nextRunAt)} · Last: {formatDateTime(script.lastRunAt)} · {script.timezone}</p></div><div className="flex flex-wrap items-center gap-1"><Toggle size="sm" checked={script.enabled} onChange={() => void toggleScript(script)} title={script.enabled ? "Disable" : "Enable"} /><Button size="sm" variant="outline" icon="play_arrow" loading={runningId === script.id} onClick={() => void runScript(script)}>Run now</Button><Button size="sm" variant="ghost" icon="history" onClick={() => setHistoryScript(script)}>History</Button><Button size="sm" variant="ghost" icon="edit" onClick={() => openEdit(script)}>Edit</Button><Button size="sm" variant="ghost" icon="delete" onClick={() => setDeleteTarget(script)}>Delete</Button></div></div></Card>)}</div>}
      <FormModal isOpen={formOpen} editing={editing} form={form} saving={saving} onClose={() => setFormOpen(false)} onChange={updateForm} onSave={() => void saveScript()} onUseExample={useExample} onClearSecret={() => updateForm("secretAction", "clear")} />
      <RunsModal isOpen={Boolean(historyScript)} script={historyScript} runs={runs} loading={historyLoading} onClose={() => setHistoryScript(null)} />
      <ConfirmModal isOpen={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} loading={deleting} title="Delete check-in script" message={deleteTarget ? `Delete “${deleteTarget.name}” and its run history?` : ""} confirmText="Delete" />
    </div>
  );
}
