import { KeyRound } from "lucide-react";
import type { TableStructure } from "../lib/api";
import { formatCount } from "../lib/format";

export function StructureView({ s }: { s: TableStructure }) {
  return (
    <div className="structure">
      <div className="structure-meta">
        {s.estimatedRows >= 0 && (
          <span>
            ~<b>{formatCount(s.estimatedRows)}</b> rows
          </span>
        )}
        {s.totalSize && (
          <span>
            <b>{s.totalSize}</b> on disk
          </span>
        )}
        <span>
          <b>{s.columns.length}</b> columns
        </span>
        {s.comment && <span className="structure-comment">{s.comment}</span>}
      </div>

      <section>
        <h3>Columns</h3>
        <table className="info-table">
          <thead>
            <tr>
              <th style={{ width: 24 }} />
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {s.columns.map((c) => (
              <tr key={c.name}>
                <td>{c.primaryKey && <KeyRound size={12} className="pk" aria-label="Primary key" />}</td>
                <td className="mono strong">{c.name}</td>
                <td className="mono type">{c.dataType}</td>
                <td>{c.nullable ? "yes" : <span className="muted">not null</span>}</td>
                <td className="mono muted">{c.generated ?? c.default ?? ""}</td>
                <td className="muted">{c.comment ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {s.indexes.length > 0 && (
        <section>
          <h3>Indexes</h3>
          <table className="info-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Definition</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {s.indexes.map((i) => (
                <tr key={i.name}>
                  <td className="mono strong">
                    {i.name} {i.primary ? <span className="badge">primary</span> : i.unique ? <span className="badge">unique</span> : null}
                  </td>
                  <td className="mono muted wrap">{i.definition}</td>
                  <td className="muted nowrap">{i.size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {s.constraints.length > 0 && (
        <section>
          <h3>Constraints</h3>
          <table className="info-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Definition</th>
              </tr>
            </thead>
            <tbody>
              {s.constraints.map((c) => (
                <tr key={c.name}>
                  <td className="mono strong">{c.name}</td>
                  <td className="nowrap">{c.kind}</td>
                  <td className="mono muted wrap">{c.definition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {s.definition && (
        <section>
          <h3>Definition</h3>
          <pre className="definition">{s.definition.trim()}</pre>
        </section>
      )}
    </div>
  );
}
