/** Edited grid cells: kept per tab until reviewed and saved in one transaction, or discarded. */
import { CircleAlert, Copy, Save, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, newId, toAppError, type AppError, type Cell } from "../lib/api";
import { buildEdits, cellKey, changedRows, type Editability, type Pending } from "../lib/edits";
import { formatCount } from "../lib/format";
import { useApp } from "../lib/store";
import { Modal, Spinner, copyText } from "./ui";

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

export function useEdits(o: {
  tabId: string;
  connId: string | null;
  /** The table the rows come from. */
  target: { schema: string; table: string } | null;
  columns: string[];
  rows: Cell[][];
  /** Null while it isn't known yet. */
  info: Editability | null;
  /** New rows (another page, a new result): their changes are dropped. */
  resetKey: unknown;
  /** Saved: the owner shows the new values (reload, or patch its rows). */
  onSaved: (pending: Pending) => void;
}) {
  const { tabId, connId, target, columns, rows, info, onSaved } = o;
  const [pending, setPending] = useState<Pending>({});
  const n = Object.keys(pending).length;

  useEffect(() => setPending({}), [o.resetKey]);
  // closing the tab asks first
  useEffect(() => useApp.getState().setUnsaved(tabId, n), [tabId, n]);
  useEffect(() => () => useApp.getState().setUnsaved(tabId, 0), [tabId]);

  const onEdit = useCallback(
    (r: number, c: number, value: Cell) =>
      setPending((p) => {
        const next = { ...p };
        // back to what was loaded: no change
        if (value === rows[r]?.[c]) delete next[cellKey(r, c)];
        else next[cellKey(r, c)] = value;
        return next;
      }),
    [rows],
  );

  /** Runs `action` (paging, sorting, a new run…) once unsaved changes are saved or let go. */
  const guard = useCallback(
    (action: () => void) => {
      if (!n) return action();
      useApp.getState().setDialog({
        kind: "confirm",
        title: "Discard unsaved changes?",
        body: `${plural(n, "changed value")} in ${plural(changedRows(pending), "row")} haven't been saved.`,
        action: "Discard changes",
        onConfirm: () => {
          setPending({});
          action();
        },
      });
    },
    [n, pending],
  );

  const review = async () => {
    if (!connId || !target || !info?.ok) return;
    const { toast, setDialog } = useApp.getState();
    const edits = buildEdits(columns, rows, info.pk, pending);
    const base = { id: connId, schema: target.schema, table: target.table, edits };
    try {
      const { statements } = await api.applyEdits({ ...base, queryId: newId(), dryRun: true });
      setDialog({
        kind: "review",
        connId,
        title: `${target.schema}.${target.table}`,
        statements,
        onSave: async (queryId) => {
          const out = await api.applyEdits({ ...base, queryId });
          setPending({});
          onSaved(pending);
          toast(`Saved ${plural(out.saved, "row")} in ${target.table}`);
        },
      });
    } catch (e) {
      toast(toAppError(e).message, "error");
    }
  };

  const bar = n ? (
    <div className="edit-bar" role="status">
      <span>
        <b>{plural(n, "changed value")}</b> in {plural(changedRows(pending), "row")}, not saved yet
      </span>
      <div className="spacer" />
      <button type="button" className="btn small" onClick={() => setPending({})}>
        <Undo2 size={13} /> Discard
      </button>
      <button type="button" className="btn small primary" onClick={() => void review()}>
        <Save size={13} /> Review &amp; save
      </button>
    </div>
  ) : null;

  return {
    pending,
    onEdit: info?.ok ? onEdit : undefined,
    editable: info?.ok ? info.editable : undefined,
    readOnlyReason: info && !info.ok ? info.reason : undefined,
    bar,
    guard,
  };
}

/** The UPDATEs about to run; Save runs them in one transaction. */
export function ReviewDialog({ connId, title, statements, onSave }: { connId: string; title: string; statements: string[]; onSave: (queryId: string) => Promise<void> }) {
  const { setDialog } = useApp.getState();
  const conn = useApp((s) => s.connections.find((c) => c.id === connId));
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const sql = statements.map((s) => `${s};`).join("\n");

  const save = async () => {
    const queryId = newId();
    setSaving(queryId);
    setError(null);
    try {
      await onSave(queryId);
      setDialog(null);
    } catch (e) {
      setError(toAppError(e));
      setSaving(null);
    }
  };
  const close = () => {
    if (saving) void api.cancel(saving);
    setDialog(null);
  };

  return (
    <Modal
      title={
        <>
          Save changes to {title} {conn?.production && <span className="prod-badge">prod</span>}
        </>
      }
      onClose={close}
      width={680}
      footer={
        <>
          <button type="button" className="btn ghost small" onClick={() => copyText(sql, "Copied the SQL")}>
            <Copy size={13} /> Copy SQL
          </button>
          {saving && (
            <span className="muted export-progress">
              <Spinner size={13} /> Saving…
            </span>
          )}
          <div className="spacer" />
          <button type="button" className="btn" onClick={close}>
            {saving ? "Stop" : "Cancel"}
          </button>
          <button type="button" className="btn primary" disabled={!!saving} onClick={() => void save()}>
            Save {plural(statements.length, "row")}
          </button>
        </>
      }
    >
      <p className="muted review-note">
        {statements.length === 1 ? "This statement runs" : `These ${statements.length} statements run`} in one transaction on {conn?.name ?? "the connection"}. If
        a row has been deleted or its key changed since it was loaded, nothing is saved.
      </p>
      <pre className="value-view review-sql">{sql}</pre>
      {error && (
        <div className="test-result bad" role="alert">
          <CircleAlert size={14} />
          <span>{error.message}</span>
        </div>
      )}
    </Modal>
  );
}
