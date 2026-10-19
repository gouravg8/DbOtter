/**
 * Read-only result grid. Only the rows and columns in view are rendered, so 100k rows cost
 * the same as 100. Keyboard: arrows (or h j k l with vim keys), Shift to extend, Enter to
 * view a value, Ctrl/⌘ C or y to copy, Y to copy whole rows, gg / G, Ctrl d / u.
 */
import { ArrowDown, ArrowUp, Braces, Copy, Eye, Filter, Rows3, Sheet } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Cell } from "../lib/api";
import { toCsv, toJson, toTsv } from "../lib/format";
import { modKey, MOD } from "../lib/store";
import { Modal, copyText, useMenu } from "./ui";

export interface GridColumn {
  name: string;
  /** Postgres type, when known (table browsing). */
  type?: string;
}

interface Props {
  columns: GridColumn[];
  rows: Cell[][];
  /** Row number of the first row minus one (paging). */
  rowOffset?: number;
  sort?: { column: string; desc: boolean } | null;
  onSort?: (column: string) => void;
  onFilterValue?: (column: string, value: Cell) => void;
  vim: boolean;
  /** Changing it scrolls back to the top and clears the selection (new result). */
  resetKey?: unknown;
  autoFocus?: boolean;
}

const ROW_H = 26;
const OVERSCAN = 6;
const MAX_RENDER = 300;
const NUMERIC = /^(smallint|integer|bigint|numeric|decimal|real|double precision|money|int[248]?|float[48])/;

type Pos = { r: number; c: number };

/** Width that fits the header and the first rows, measured with the grid's own font. */
function autoWidths(el: HTMLElement, columns: GridColumn[], rows: Cell[][]) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const style = getComputedStyle(el);
  const font = `${style.fontSize} ${style.fontFamily}`;
  const sample = rows.slice(0, 300);
  return columns.map((col, c) => {
    ctx.font = `600 ${font}`;
    let w = ctx.measureText(col.name).width + 38;
    if (col.type) {
      ctx.font = `${parseFloat(style.fontSize) * 0.85}px ${style.fontFamily}`;
      w = Math.max(w, ctx.measureText(col.type).width + 28);
    }
    ctx.font = font;
    for (const row of sample) {
      const v = row[c];
      if (v === null) continue;
      // padding 20 + border + slack for canvas/DOM rounding
      w = Math.max(w, ctx.measureText(v.length > 80 ? v.slice(0, 80) : v).width + 28);
      if (w >= 380) break;
    }
    return Math.round(Math.min(380, Math.max(64, w)));
  });
}

const display = (v: string) => {
  const s = v.length > MAX_RENDER ? `${v.slice(0, MAX_RENDER)}…` : v;
  return s.includes("\n") ? s.replace(/\r?\n/g, " ↵ ") : s;
};

/** JSON objects and arrays pretty-printed; anything else as is. */
function pretty(v: string) {
  const t = v.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON (e.g. a Postgres array) */
    }
  }
  return v;
}

export const DataGrid = memo(function DataGrid({
  columns,
  rows,
  rowOffset = 0,
  sort,
  onSort,
  onFilterValue,
  vim,
  resetKey,
  autoFocus,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[] | null>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [view, setView] = useState({ w: 800, h: 400 });
  const [active, setActiveState] = useState<Pos | null>(null);
  const [anchor, setAnchorState] = useState<Pos | null>(null);
  // keys can arrive faster than renders: the key handler reads these
  const cur = useRef<{ active: Pos | null; anchor: Pos | null }>({ active: null, anchor: null });
  const setActive = (p: Pos | null) => {
    cur.current.active = p;
    setActiveState(p);
  };
  const setAnchor = (p: Pos | null) => {
    cur.current.anchor = p;
    setAnchorState(p);
  };
  const [viewer, setViewer] = useState<Pos | null>(null);
  const dragging = useRef(false);
  const pendingG = useRef(0);
  const menu = useMenu();

  const withTypes = columns.some((c) => c.type);
  const headerH = withTypes ? 40 : 30;
  const gutter = Math.max(44, String(rowOffset + rows.length).length * 8 + 22);
  const colsKey = columns.map((c) => `${c.name}:${c.type ?? ""}`).join("|");

  useLayoutEffect(() => {
    if (ref.current) setWidths(autoWidths(ref.current, columns, rows));
    // re-measure when the columns change, not on every page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey]);

  useEffect(() => {
    setActive(null);
    setAnchor(null);
    ref.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  useEffect(() => {
    if (!autoFocus) return;
    // data arrives later: don't take focus from wherever the user has gone since (e.g. the tree)
    const el = document.activeElement;
    const pane = ref.current?.closest(".tab-pane");
    if (!el || el === document.body || pane?.contains(el) || el.closest(".tab-pane[hidden]")) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setView({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const w = widths ?? columns.map(() => 120);
  const offsets = useMemo(() => {
    const o = [0];
    for (const x of w) o.push(o.at(-1)! + x);
    return o;
  }, [w]);
  const totalW = offsets.at(-1)!;

  // visible window
  const r0 = Math.max(0, Math.floor((scroll.top - headerH) / ROW_H) - OVERSCAN);
  const r1 = Math.min(rows.length, Math.ceil((scroll.top + view.h - headerH) / ROW_H) + OVERSCAN);
  let c0 = 0;
  while (c0 < columns.length - 1 && offsets[c0 + 1] < scroll.left) c0++;
  let c1 = c0;
  while (c1 < columns.length && offsets[c1] < scroll.left + view.w - gutter) c1++;
  c1 = Math.min(columns.length, c1 + 1);

  const selOf = (active: Pos | null, anchor: Pos | null) =>
    active && anchor
      ? {
          r0: Math.min(active.r, anchor.r),
          r1: Math.max(active.r, anchor.r),
          c0: Math.min(active.c, anchor.c),
          c1: Math.max(active.c, anchor.c),
        }
      : null;
  const sel = active && anchor
    ? {
        r0: Math.min(active.r, anchor.r),
        r1: Math.max(active.r, anchor.r),
        c0: Math.min(active.c, anchor.c),
        c1: Math.max(active.c, anchor.c),
      }
    : null;

  const scrollIntoView = useCallback(
    (p: Pos) => {
      const el = ref.current!;
      const top = headerH + p.r * ROW_H;
      if (top - headerH < el.scrollTop) el.scrollTop = top - headerH;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
      const left = offsets[p.c];
      const right = offsets[p.c + 1];
      const viewW = el.clientWidth - gutter;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + viewW) el.scrollLeft = Math.min(left, right - viewW);
    },
    [headerH, offsets, gutter],
  );

  const moveTo = (p: Pos, extend: boolean) => {
    const q = { r: Math.max(0, Math.min(rows.length - 1, p.r)), c: Math.max(0, Math.min(columns.length - 1, p.c)) };
    setActive(q);
    if (!extend) setAnchor(q);
    scrollIntoView(q);
  };

  const selectedCols = () => (sel ? columns.slice(sel.c0, sel.c1 + 1).map((c) => c.name) : []);
  const latestSel = () => selOf(cur.current.active, cur.current.anchor);

  const copySelection = () => {
    const sel = latestSel();
    if (!sel) return;
    if (sel.r0 === sel.r1 && sel.c0 === sel.c1) return copyText(rows[sel.r0][sel.c0] ?? "", "Copied value");
    const n = sel.r1 - sel.r0 + 1;
    const block = rows.slice(sel.r0, sel.r1 + 1).map((r) => r.slice(sel.c0, sel.c1 + 1));
    copyText(toTsv(null, block), `Copied ${n} row${n > 1 ? "s" : ""}`);
  };
  const copyRows = () => {
    const sel = latestSel();
    if (!sel) return;
    const n = sel.r1 - sel.r0 + 1;
    copyText(toTsv(columns.map((c) => c.name), rows.slice(sel.r0, sel.r1 + 1)), `Copied ${n} row${n > 1 ? "s" : ""} with headers`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!rows.length) return;
    const { active, anchor } = cur.current;
    const p = active ?? { r: 0, c: 0 };
    const k0 = e.key;
    // Ctrl+Tab switches app tabs; it must not move the cell
    if (k0 === "Tab" && (e.ctrlKey || e.metaKey || e.altKey)) return;
    // nothing selected yet: the first move lands on the first cell rather than past it
    const firstMove = /^Arrow(Up|Down|Left|Right)$/.test(k0) || (vim && /^[hjkl]$/.test(k0)) || (k0 === "Tab" && !e.shiftKey);
    if (!active && firstMove && !modKey(e)) {
      e.preventDefault();
      moveTo({ r: 0, c: 0 }, false);
      return;
    }
    const page = Math.max(1, Math.floor((view.h - headerH) / ROW_H) - 1);
    const k = e.key;
    const mod = modKey(e);
    const shift = e.shiftKey;
    const vimKey = vim && !mod && !e.altKey;
    let next: Pos | null = null;

    if (k === "ArrowDown" || (vimKey && k === "j")) next = { r: p.r + 1, c: p.c };
    else if (k === "ArrowUp" || (vimKey && k === "k")) next = { r: p.r - 1, c: p.c };
    else if (k === "ArrowLeft" || (vimKey && k === "h")) next = { r: p.r, c: p.c - 1 };
    else if (k === "ArrowRight" || (vimKey && k === "l")) next = { r: p.r, c: p.c + 1 };
    // Tab moves across cells, and out of the grid from the first / last one
    else if (k === "Tab" && !shift && p.c < columns.length - 1) next = { r: p.r, c: p.c + 1 };
    else if (k === "Tab" && shift && p.c > 0) next = { r: p.r, c: p.c - 1 };
    else if (k === "PageDown" || (vim && e.ctrlKey && k === "d")) next = { r: p.r + page, c: p.c };
    else if (k === "PageUp" || (vim && e.ctrlKey && k === "u")) next = { r: p.r - page, c: p.c };
    else if ((k === "Home" && mod) || (vimKey && k === "g" && Date.now() - pendingG.current < 600)) next = { r: 0, c: p.c };
    else if ((k === "End" && mod) || (vimKey && k === "G")) next = { r: rows.length - 1, c: p.c };
    else if (k === "Home" || (vimKey && (k === "0" || k === "^"))) next = { r: p.r, c: 0 };
    else if (k === "End" || (vimKey && k === "$")) next = { r: p.r, c: columns.length - 1 };

    if (vimKey && k === "g") {
      pendingG.current = next ? 0 : Date.now();
      if (!next) return e.preventDefault();
    }
    if (next) {
      e.preventDefault();
      // Shift extends with navigation keys only (Shift+Tab moves back, G is a motion)
      moveTo(next, shift && /^(Arrow|Page|Home|End)/.test(k));
      return;
    }
    if (mod && k.toLowerCase() === "c") {
      e.preventDefault();
      copySelection();
    } else if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ r: 0, c: 0 });
      setActive({ r: rows.length - 1, c: columns.length - 1 });
    } else if (vimKey && k === "y") {
      copySelection();
    } else if (vimKey && k === "Y") {
      copyRows();
    } else if ((k === "Enter" && !mod) || (vimKey && k === "o")) {
      if (active) {
        e.preventDefault();
        setViewer(active);
      }
    } else if (k === "Escape" && active && anchor && (active.r !== anchor.r || active.c !== anchor.c)) {
      e.stopPropagation();
      setAnchor(active);
    }
  };

  const contextMenu = (e: React.MouseEvent, p: Pos) => {
    e.preventDefault();
    const inside = sel && p.r >= sel.r0 && p.r <= sel.r1 && p.c >= sel.c0 && p.c <= sel.c1;
    if (!inside) {
      setActive(p);
      setAnchor(p);
    }
    const s = inside ? sel! : { r0: p.r, r1: p.r, c0: p.c, c1: p.c };
    const cols = columns.slice(s.c0, s.c1 + 1).map((c) => c.name);
    const block = rows.slice(s.r0, s.r1 + 1).map((r) => r.slice(s.c0, s.c1 + 1));
    const full = rows.slice(s.r0, s.r1 + 1);
    const value = rows[p.r][p.c];
    const col = columns[p.c].name;
    menu.open(e.clientX, e.clientY, [
      { label: "Copy value", icon: <Copy size={14} />, hint: `${MOD} C`, onSelect: () => copyText(value ?? "", "Copied value") },
      { label: "View value", icon: <Eye size={14} />, hint: "Enter", onSelect: () => setViewer(p) },
      "divider",
      { label: "Copy as TSV", icon: <Sheet size={14} />, onSelect: () => copyText(toTsv(cols, block), "Copied as TSV") },
      { label: "Copy as CSV", icon: <Sheet size={14} />, onSelect: () => copyText(toCsv(cols, block), "Copied as CSV") },
      { label: "Copy as JSON", icon: <Braces size={14} />, onSelect: () => copyText(toJson(cols, block), "Copied as JSON") },
      {
        label: s.r0 === s.r1 ? "Copy row as JSON" : "Copy rows as JSON",
        icon: <Rows3 size={14} />,
        onSelect: () => copyText(toJson(columns.map((c) => c.name), full), "Copied rows as JSON"),
      },
      ...(onFilterValue
        ? [
            "divider" as const,
            {
              label: value === null ? `Filter: ${col} is null` : `Filter: ${col} = ${value.length > 24 ? `${value.slice(0, 24)}…` : value}`,
              icon: <Filter size={14} />,
              onSelect: () => onFilterValue(col, value),
            },
          ]
        : []),
    ]);
  };

  const startResize = (e: React.MouseEvent, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = w[c];
    const move = (ev: MouseEvent) => {
      const next = [...w];
      next[c] = Math.max(48, start + ev.clientX - startX);
      setWidths(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const visibleCols = columns.slice(c0, c1).map((col, i) => ({ col, c: c0 + i }));

  return (
    <div
      ref={ref}
      className="grid"
      tabIndex={0}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
      onKeyDown={onKeyDown}
      onScroll={(e) => {
        const el = e.currentTarget;
        setScroll({ top: el.scrollTop, left: el.scrollLeft });
      }}
    >
      <div style={{ width: gutter + totalW, minWidth: "100%" }}>
        <div className="grid-head" style={{ height: headerH }}>
          <div className="grid-corner" style={{ width: gutter }} />
          <div style={{ width: offsets[c0], flex: "none" }} />
          {visibleCols.map(({ col, c }) => {
            const sorted = sort?.column === col.name ? sort : null;
            return (
              <div
                key={c}
                className={`grid-hcell ${onSort ? "sortable" : ""} ${sel && c >= sel.c0 && c <= sel.c1 ? "in-sel" : ""}`}
                style={{ width: w[c] }}
                title={col.type ? `${col.name} · ${col.type}` : col.name}
                onClick={() => onSort?.(col.name)}
              >
                <span className="grid-hname">
                  {col.name}
                  {sorted && (sorted.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                </span>
                {col.type && <span className="grid-htype">{col.type}</span>}
                <span
                  className="grid-resize"
                  onMouseDown={(e) => startResize(e, c)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (!ref.current) return;
                    const fit = autoWidths(ref.current, [col], rows.map((r) => [r[c]]))[0];
                    setWidths(w.map((x, i) => (i === c ? fit : x)));
                  }}
                />
              </div>
            );
          })}
        </div>

        <div className="grid-body" style={{ height: rows.length * ROW_H }}>
          {rows.slice(r0, r1).map((row, i) => {
            const r = r0 + i;
            const rowSel = sel && r >= sel.r0 && r <= sel.r1;
            return (
              <div
                key={r}
                className={`grid-row ${r % 2 ? "odd" : ""}`}
                style={{ top: r * ROW_H, width: gutter + totalW }}
              >
                <div
                  className={`grid-gutter ${rowSel ? "in-sel" : ""}`}
                  style={{ width: gutter }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    ref.current?.focus({ preventScroll: true });
                    setAnchor(e.shiftKey && anchor ? { r: anchor.r, c: 0 } : { r, c: 0 });
                    setActive({ r, c: columns.length - 1 });
                  }}
                >
                  {rowOffset + r + 1}
                </div>
                <div style={{ width: offsets[c0], flex: "none" }} />
                {visibleCols.map(({ c, col }) => {
                  const v = row[c];
                  const isActive = active?.r === r && active.c === c;
                  const inSel = rowSel && c >= sel!.c0 && c <= sel!.c1;
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      className={`grid-cell ${v === null ? "is-null" : ""} ${col.type && NUMERIC.test(col.type) ? "num" : ""} ${
                        inSel ? "in-sel" : ""
                      } ${isActive ? "active" : ""}`}
                      style={{ width: w[c] }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        ref.current?.focus({ preventScroll: true });
                        dragging.current = true;
                        setActive({ r, c });
                        if (!e.shiftKey || !anchor) setAnchor({ r, c });
                      }}
                      onMouseEnter={() => dragging.current && setActive({ r, c })}
                      onDoubleClick={() => setViewer({ r, c })}
                      onContextMenu={(e) => contextMenu(e, { r, c })}
                    >
                      {v === null ? "NULL" : display(v)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {!rows.length && <div className="grid-empty">No rows</div>}
      </div>

      {menu.element}
      {viewer && rows[viewer.r] && (
        <ValueViewer
          column={columns[viewer.c]}
          value={rows[viewer.r][viewer.c]}
          row={rowOffset + viewer.r + 1}
          vim={vim}
          onClose={() => {
            setViewer(null);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1) && (
        <div className="grid-selinfo">
          {sel.r1 - sel.r0 + 1} × {sel.c1 - sel.c0 + 1} selected · {selectedCols().length > 1 ? "y / " : ""}
          {MOD} C to copy
        </div>
      )}
    </div>
  );
});

function ValueViewer({ column, value, row, vim, onClose }: { column: GridColumn; value: Cell; row: number; vim: boolean; onClose: () => void }) {
  const text = value === null ? null : pretty(value);
  return (
    <Modal
      title={
        <>
          {column.name} <span className="muted">· row {row}{column.type ? ` · ${column.type}` : ""}</span>
        </>
      }
      onClose={onClose}
      width={640}
      footer={
        <>
          <span className="muted small">{value === null ? "NULL" : `${value.length.toLocaleString()} characters`}</span>
          <button type="button" className="btn" onClick={() => copyText(value ?? "", "Copied value")} disabled={value === null}>
            <Copy size={14} /> Copy
          </button>
        </>
      }
    >
      {text === null ? (
        <div className="null big">NULL</div>
      ) : (
        <pre
          className="value-view"
          tabIndex={0}
          onKeyDown={(e) => {
            const k = e.key.toLowerCase();
            const nothingSelected = !window.getSelection()?.toString();
            if ((modKey(e) && k === "c" && nothingSelected) || (vim && e.key === "y" && !modKey(e))) {
              e.preventDefault();
              void copyText(value ?? "", "Copied value");
            } else if (modKey(e) && k === "a") {
              // just the value, not the whole page
              e.preventDefault();
              window.getSelection()?.selectAllChildren(e.currentTarget);
            }
          }}
        >
          {text}
        </pre>
      )}
    </Modal>
  );
}
