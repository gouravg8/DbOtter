import { CircleAlert, Download } from "lucide-react";
import { formatBytes } from "../lib/export";
import { useApp } from "../lib/store";
import { installUpdate, useUpdates } from "../lib/updates";
import { Modal, Spinner } from "./ui";

/** The update found: what's new, then download progress and a restart. */
export function UpdateDialog() {
  const { setDialog } = useApp.getState();
  const state = useUpdates((s) => s.state);
  const busy = state.status === "downloading" || state.status === "installing";
  const version = "version" in state ? state.version : "";
  const notes = "notes" in state ? state.notes.trim() : "";
  return (
    <Modal
      title={version ? `Update to DbOtter ${version}` : "Update DbOtter"}
      onClose={() => !busy && setDialog(null)}
      width={520}
      footer={
        <>
          {state.status === "downloading" && (
            <span className="muted export-progress">
              <Spinner size={13} /> Downloading… {formatBytes(state.done)}
              {state.total ? ` of ${formatBytes(state.total)}` : ""}
            </span>
          )}
          {state.status === "installing" && (
            <span className="muted export-progress">
              <Spinner size={13} /> Installing, DbOtter restarts in a moment…
            </span>
          )}
          <div className="spacer" />
          <button type="button" className="btn" disabled={busy} onClick={() => setDialog(null)}>
            Later
          </button>
          <button type="button" className="btn primary" disabled={busy || state.status !== "available"} onClick={() => void installUpdate()}>
            <Download size={13} /> Install and restart
          </button>
        </>
      }
    >
      {state.status === "downloading" && state.total ? (
        <div className="update-bar">
          <span style={{ width: `${Math.min(100, (state.done / state.total) * 100)}%` }} />
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="test-result bad" role="alert">
          <CircleAlert size={14} />
          <span>{state.message}</span>
        </div>
      ) : (
        <>
          <p className="muted update-note">Your connections, settings and saved passwords stay as they are.</p>
          {notes && <pre className="value-view update-notes">{notes}</pre>}
        </>
      )}
    </Modal>
  );
}
