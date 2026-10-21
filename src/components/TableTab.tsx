import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  CircleAlert,
  Columns3,
  Download,
  Filter as FilterIcon,
  Plus,
  RefreshCw,
  SquareTerminal,
  Table,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  newId,
  toAppError,
  type AppError,
  type Cell,
  type Filter,
  type FilterOp,
  type TableQuery,
  type TableRows,
  type TableStructure,
} from "../lib/api";
import { qualified } from "../lib/dialect";
import { formatCount, formatDuration } from "../lib/format";
import { MOD, modKey, useApp, type TableTab as TableTabState } from "../lib/store";
import { DataGrid } from "./DataGrid";
import { StructureView } from "./StructureView";
import { Spinner } from "./ui";

const OPS: FilterOp[] = ["=", "!=", "<", ">", "<=", ">=", "contains", "not contains", "starts with", "is null", "is not null"];
const NO_VALUE = new Set<FilterOp>(["is null", "is not null"]);
/** Types without an = operator: comparisons on them go through ::text. */
const NO_EQUALITY = /^(json|xml|point|line|lseg|box|path|polygon|circle)\b/;


export function TableTab({ tab, active }: { tab: TableTabState; active: boolean }) {
  const settings = useApp((s) => s.settings);
  const session = useApp((s) => s.sessions[tab.connId]);
  const { updateTab, connect, openQueryTab } = useApp.getState();
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const types = new Map(structure?.columns.map((c) => [c.name, c.dataType]));
  const [data, setData] = useState<TableRows | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  // kept apart: a page loading fine must not hide a failed structure query
  const [structureError, setStructureError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<TableQuery["sort"]>(null);
  // filters being edited vs. applied
  const [draft, setDraft] = useState<Filter[]>([]);
  const [whereDraft, setWhereDraft] = useState("");
  const [applied, setApplied] = useState<{ filters: Filter[]; where: string }>({ filters: [], where: "" });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [reload, setReload] = useState(0);
  // restored tabs load nothing until they are first shown
  const [shown, setShown] = useState(active);
  const firstValue = useRef<HTMLInputElement>(null);
  const queryId = useRef<string | null>(null);
  const countId = useRef<string | null>(null);
  const connected = session?.status === "connected";
  const pageSize = settings.pageSize;

  // connect when the tab is opened or switched to (e.g. restored from last time); not when
  // the user disconnects while it's open
  useEffect(() => {
    if (!active) return;
    setShown(true);
    if (!useApp.getState().sessions[tab.connId]) void connect(tab.connId);
  }, [active, connect, tab.connId]);

  useEffect(() => {
    if (!shown || !connected || structure) return;
    setStructureError(null);
    api
      .structure(tab.connId, tab.schema, tab.table)
      .then(setStructure)
      .catch((e) => setStructureError(toAppError(e)));
    // reload: Refresh retries a structure query that failed
  }, [shown, connected, structure, tab.connId, tab.schema, tab.table, reload]);

  const query = useCallback(
    (): TableQuery => ({
      schema: tab.schema,
      table: tab.table,
      limit: pageSize,
      offset,
      sort,
      filters: applied.filters,
      whereRaw: applied.where || null,
    }),
    [tab.schema, tab.table, pageSize, offset, sort, applied],
  );

  // every row with the filters and sort shown (the backend drops the paging)
  const openExport = useCallback(
    () => useApp.getState().setDialog({ kind: "export", target: { kind: "table", connId: tab.connId, query: query() } }),
    [tab.connId, query],
  );
  useEffect(() => {
    if (!active) return;
    window.addEventListener("dbotter:export", openExport);
    return () => window.removeEventListener("dbotter:export", openExport);
  }, [active, openExport]);

  useEffect(() => {
    if (!shown || !connected || tab.view !== "data") return;
    let stale = false;
    const id = newId();
    queryId.current = id;
    setLoading(true);
    api
      .tableRows(tab.connId, id, query())
      .then((d) => {
        if (stale) return;
        setData(d);
        setError(null);
      })
      .catch((e) => !stale && setError(toAppError(e)))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
      void api.cancel(id).catch(() => {});
    };
  }, [shown, connected, tab.view, tab.connId, query, reload]);

  // count again when the filters change or on refresh; a count still running is dropped
  useEffect(() => {
    setCount(null);
    setCounting(false);
    if (countId.current) void api.cancel(countId.current).catch(() => {});
    countId.current = null;
  }, [applied, tab.connId, reload]);

  useEffect(() => {
    if (!active) return;
    const refresh = () => {
      setStructure(null);
      setReload((n) => n + 1);
    };
    const focus = () => document.querySelector<HTMLElement>(`[data-tab="${tab.id}"] .grid`)?.focus();
    window.addEventListener("dbotter:refresh", refresh);
    window.addEventListener("dbotter:focus-main", focus);
    return () => {
      window.removeEventListener("dbotter:refresh", refresh);
      window.removeEventListener("dbotter:focus-main", focus);
    };
  }, [active, tab.id]);

  const apply = (filters = draft, where = whereDraft) => {
    const clean = filters
      .filter((f) => f.column && (NO_VALUE.has(f.op) || f.value !== ""))
      .map((f) => ({ ...f, asText: f.asText || asText(f.column) }));
    setApplied({ filters: clean, where: where.trim() });
    setOffset(0);
  };

  const openFilters = () => {
    setFiltersOpen(true);
    if (!draft.length && data) setDraft([{ column: data.result.columns[0], op: "=", value: "" }]);
    setTimeout(() => firstValue.current?.focus(), 0);
  };

  const asText = (column: string) => NO_EQUALITY.test(types.get(column) ?? "");

  const filterByValue = (column: string, value: Cell) => {
    const f: Filter = value === null ? { column, op: "is null", value: "" } : { column, op: "=", value, asText: asText(column) };
    const next = [...draft.filter((d) => d.column !== column || d.value !== ""), f];
    setDraft(next);
    setFiltersOpen(true);
    apply(next);
  };

  const onSort = (column: string) => {
    setOffset(0);
    setSort((s) => (s?.column !== column ? { column, desc: false } : s.desc ? null : { column, desc: true }));
  };

  const runCount = async () => {
    const id = newId();
    countId.current = id;
    setCounting(true);
    try {
      const n = await api.tableCount(tab.connId, id, query());
      // filters changed meanwhile: this count is for the old ones
      if (countId.current === id) setCount(n);
    } catch (e) {
      if (countId.current === id) useApp.getState().toast(toAppError(e).message, "error");
    } finally {
      if (countId.current === id) {
        setCounting(false);
        countId.current = null;
      }
    }
  };

  const rows = data?.result.rows ?? [];
  const estimate = structure && structure.estimatedRows >= 0 && !applied.filters.length && !applied.where ? structure.estimatedRows : null;
  const total = count ?? null;
  const hasNext = total !== null ? offset + rows.length < total : rows.length === pageSize;
  const filtered = applied.filters.length > 0 || !!applied.where;

  const page = (dir: -1 | 1 | 0) => {
    if (dir === 0) setOffset(0);
    else if (dir === 1 && hasNext) setOffset(offset + pageSize);
    else if (dir === -1 && offset > 0) setOffset(Math.max(0, offset - pageSize));
  };

  return (
    <div
      className="table-tab"
      onKeyDown={(e) => {
        const inField = (e.target as HTMLElement).closest("input, select, textarea");
        if (modKey(e) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          openFilters();
        } else if (!inField && !modKey(e) && (e.key === "]" || e.key === "[")) {
          e.preventDefault();
          page(e.key === "]" ? 1 : -1);
        } else if (!inField && settings.vim && e.key === "/") {
          e.preventDefault();
          openFilters();
        }
      }}
    >
      <div className="toolbar">
        <span className="crumb">
          <Table size={14} />
          <span className="muted">{tab.schema}.</span>
          <b>{tab.table}</b>
          {tab.relKind !== "table" && <span className="badge">{tab.relKind === "view" ? "view" : tab.relKind === "materializedView" ? "materialized view" : "foreign"}</span>}
        </span>
        <div className="segmented" role="tablist">
          <button type="button" role="tab" aria-selected={tab.view === "data"} className={tab.view === "data" ? "active" : ""} onClick={() => updateTab(tab.id, { view: "data" })}>
            <Table size={13} /> Data
          </button>
          <button type="button" role="tab" aria-selected={tab.view === "structure"} className={tab.view === "structure" ? "active" : ""} onClick={() => updateTab(tab.id, { view: "structure" })}>
            <Columns3 size={13} /> Structure
          </button>
        </div>
        <div className="spacer" />
        {tab.view === "data" && (
          <button type="button" className={`btn ${filtered ? "active" : ""}`} onClick={() => (filtersOpen ? setFiltersOpen(false) : openFilters())} title={`Filter rows (${MOD} F)`}>
            <FilterIcon size={13} /> Filter{filtered ? ` · ${applied.filters.length + (applied.where ? 1 : 0)}` : ""}
          </button>
        )}
        {tab.view === "data" && (
          <button type="button" className="btn" onClick={openExport} title="Export every row to a file (CSV, JSON, SQL)">
            <Download size={13} /> Export
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title="Open this query in a new tab"
          onClick={() =>
            openQueryTab(
              tab.connId,
              data?.sql.replace(/ LIMIT \d+( OFFSET \d+)?$/, ` LIMIT ${pageSize}`) ??
                `SELECT * FROM ${qualified(session?.info?.kind ?? "postgres", tab.schema, tab.table)} LIMIT 100`,
            )
          }
        >
          <SquareTerminal size={15} />
        </button>
        <button type="button" className="icon-btn" title={`Refresh (${MOD} R)`} onClick={() => { setStructure(null); setReload((n) => n + 1); }}>
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>

      {tab.view === "data" && filtersOpen && (
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
          onKeyDown={(e) => e.key === "Escape" && (setFiltersOpen(false), e.stopPropagation())}
        >
          {draft.map((f, i) => (
            <div key={i} className="filter-row">
              <select value={f.column} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, column: e.target.value } : d)))} aria-label="Column">
                {(data?.result.columns ?? structure?.columns.map((c) => c.name) ?? []).map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <select value={f.op} onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, op: e.target.value as FilterOp } : d)))} aria-label="Operator">
                {OPS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              {!NO_VALUE.has(f.op) && (
                <input
                  ref={i === 0 ? firstValue : undefined}
                  value={f.value}
                  placeholder="value"
                  aria-label="Value"
                  onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, value: e.target.value } : d)))}
                />
              )}
              <button type="button" className="icon-btn" aria-label="Remove filter" onClick={() => { const next = draft.filter((_, j) => j !== i); setDraft(next); apply(next); }}>
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="filter-row">
            <span className="where-label">WHERE</span>
            <input className="where-input mono" value={whereDraft} placeholder="raw condition, e.g. created_at > now() - interval '1 day'" onChange={(e) => setWhereDraft(e.target.value)} aria-label="Raw WHERE condition" />
          </div>
          <div className="filter-actions">
            <button type="button" className="btn ghost small" onClick={() => setDraft([...draft, { column: data?.result.columns[0] ?? "", op: "=", value: "" }])}>
              <Plus size={13} /> Add filter
            </button>
            <div className="spacer" />
            <button type="button" className="btn ghost small" onClick={() => { setDraft([]); setWhereDraft(""); apply([], ""); }}>
              Clear
            </button>
            <button type="submit" className="btn primary small">
              Apply <span className="kbd-inline">Enter</span>
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="error-panel" role="alert">
          <CircleAlert size={16} />
          <div>
            <div className="error-message">{error.message}</div>
            {error.hint && <div className="error-extra">Hint: {error.hint}</div>}
          </div>
        </div>
      )}

      {!connected && !error && (
        <div className="center-msg">
          {session?.status === "connecting" ? (
            <>
              <Spinner /> Connecting…
            </>
          ) : (
            <>
              Not connected
              <button type="button" className="btn small" onClick={() => void connect(tab.connId)}>
                Connect
              </button>
            </>
          )}
        </div>
      )}

      {connected && tab.view === "data" && data && (
        <>
          <div className={`table-grid ${loading ? "stale" : ""}`}>
            <DataGrid
              columns={data.result.columns.map((name) => ({ name, type: types.get(name) }))}
              rows={rows}
              rowOffset={offset}
              sort={sort}
              onSort={onSort}
              onFilterValue={filterByValue}
              vim={settings.vim}
              resetKey={`${offset}:${JSON.stringify(sort)}:${JSON.stringify(applied)}:${reload}`}
              autoFocus={active}
            />
          </div>
          <div className="results-foot">
            <span>
              {rows.length ? (
                <>
                  Rows <b>{formatCount(offset + 1)}–{formatCount(offset + rows.length)}</b>
                </>
              ) : (
                "No rows"
              )}
              {total !== null ? (
                <> of <b>{formatCount(total)}</b></>
              ) : estimate !== null ? (
                <span className="muted"> of ~{formatCount(estimate)}</span>
              ) : null}
            </span>
            {total === null && (
              <button type="button" className="btn ghost small" onClick={() => void runCount()} disabled={counting} title={filtered ? "Count matching rows" : "Exact row count"}>
                {counting ? <Spinner size={11} /> : null} Count
              </button>
            )}
            <span className="muted">{formatDuration(data.durationMs)}</span>
            <div className="spacer" />
            <span className="muted small kbd-hint">
              <span className="kbd-inline">[</span> <span className="kbd-inline">]</span> pages
            </span>
            <button type="button" className="icon-btn" aria-label="First page" onClick={() => page(0)} disabled={offset === 0}>
              <ChevronsLeft size={15} />
            </button>
            <button type="button" className="icon-btn" aria-label="Previous page" onClick={() => page(-1)} disabled={offset === 0}>
              <ChevronLeft size={15} />
            </button>
            <button type="button" className="icon-btn" aria-label="Next page" onClick={() => page(1)} disabled={!hasNext}>
              <ChevronRight size={15} />
            </button>
          </div>
        </>
      )}
      {connected && tab.view === "data" && !data && !error && (
        <div className="center-msg">
          <Spinner /> Loading…
        </div>
      )}
      {connected && tab.view === "structure" &&
        (structure ? (
          <StructureView s={structure} />
        ) : structureError ? (
          <div className="error-panel" role="alert">
            <CircleAlert size={16} />
            <div>
              <div className="error-message">{structureError.message}</div>
              {structureError.hint && <div className="error-extra">Hint: {structureError.hint}</div>}
            </div>
          </div>
        ) : (
          <div className="center-msg">
            <Spinner /> Loading…
          </div>
        ))}
    </div>
  );
}
