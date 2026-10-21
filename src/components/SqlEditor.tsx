/**
 * CodeMirror 6 SQL editor. Colors come from the theme's CSS variables, autocomplete from
 * the connected schema, and vim mode is a compartment toggled from settings.
 */
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  closeCompletion,
  completionKeymap,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { MariaSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect, type SQLNamespace } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
  type DecorationSet,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { DbKind, SchemaTree } from "../lib/api";
import { useApp } from "../lib/store";
import { expectsTable, tablesInStatement } from "../lib/sqlscope";
import { statementAt } from "../lib/sqlsplit";

export interface SqlEditorHandle {
  focus: () => void;
  /** Selected text, or the statement under the cursor; with its offset in the document. */
  current: () => { sql: string; offset: number } | null;
  all: () => { sql: string; offset: number };
  insert: (text: string) => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (sql: string, offset: number) => void;
  schema?: SchemaTree;
  /** Highlighting and keywords follow the database (MariaDB has its own dialect). */
  kind?: DbKind;
  product?: string;
  /** Unqualified table names complete from here. */
  defaultSchema?: string;
  vim: boolean;
  /** Document range to mark as the error location. */
  errorRange?: { from: number; to: number } | null;
  onVimMode?: (mode: string) => void;
  autoFocus?: boolean;
}

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--fg)", fontSize: "var(--editor-font-size)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--subtle)", border: "none", paddingLeft: "6px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--muted)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--hover) 55%, transparent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--selection) 50%, transparent)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--selection)", outline: "none" },
  ".cm-placeholder": { color: "var(--subtle)" },
  ".cm-sql-error": {
    textDecoration: "underline wavy var(--danger)",
    textUnderlineOffset: "3px",
    backgroundColor: "color-mix(in srgb, var(--danger) 14%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--elevated)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", fontSize: "12.5px", maxHeight: "16em" },
  ".cm-tooltip-autocomplete > ul > li": { padding: "3px 10px 3px 6px !important" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-completionDetail": { color: "var(--subtle)", fontStyle: "normal", marginLeft: "1em" },
  "li[aria-selected] .cm-completionDetail": { color: "inherit", opacity: 0.75 },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: 700 },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)", borderTop: "1px solid var(--border)" },
  ".cm-panels input, .cm-panels button": { color: "inherit", fontFamily: "var(--mono)" },
  ".cm-fat-cursor": { backgroundColor: "var(--accent) !important", color: "var(--accent-fg) !important" },
  "&:not(.cm-focused) .cm-fat-cursor": { backgroundColor: "transparent !important", outline: "1px solid var(--accent)" },
  ".cm-vim-panel": { padding: "2px 8px", fontFamily: "var(--mono)", fontSize: "12.5px" },
  ".cm-vim-panel input": { color: "var(--fg)", background: "transparent" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.lineComment, t.blockComment, t.comment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.standard(t.name)], color: "var(--syn-function)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-operator)" },
  { tag: [t.typeName, t.standard(t.typeName)], color: "var(--syn-type)" },
  { tag: t.special(t.name), color: "var(--fg)" },
]);

/** Vim emulation is ~100 KB, so it loads only once vim mode is turned on. */
let vimModule: Promise<typeof import("@replit/codemirror-vim")> | null = null;
const loadVim = () =>
  (vimModule ??= import("@replit/codemirror-vim").then((m) => {
    // :q closes the tab (Ctrl+W is vim's delete-word in vim mode)
    m.Vim.defineEx("quit", "q", () => {
      const { activeTabId, closeTab } = useApp.getState();
      if (activeTabId) closeTab(activeTabId);
    });
    return m;
  }));

/* error underline */
const setError = StateEffect.define<{ from: number; to: number } | null>();
const errorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects)
      if (e.is(setError))
        return e.value && e.value.to > e.value.from
          ? Decoration.set([Decoration.mark({ class: "cm-sql-error" }).range(e.value.from, e.value.to)])
          : Decoration.none;
    return tr.docChanged ? Decoration.none : deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Schema in the shape lang-sql completes from: schema -> table -> columns. */
function namespace(tree?: SchemaTree): SQLNamespace {
  const ns: Record<string, Record<string, SQLNamespace>> = {};
  for (const s of tree?.schemas ?? []) {
    ns[s.name] = {};
    for (const r of s.relations)
      ns[s.name][r.name] = {
        self: { label: r.name, type: r.kind === "table" ? "type" : "class", detail: r.kind === "table" ? "table" : "view" },
        children: r.columns.map((c) => ({ label: c.name, type: "property", detail: c.dataType })),
      };
  }
  return ns;
}

function dialectFor(kind?: DbKind, product?: string): SQLDialect {
  if (kind === "mysql") return product === "MariaDB" ? MariaSQL : MySQL;
  return kind === "sqlite" ? SQLite : PostgreSQL;
}

/**
 * Columns of the tables the statement under the cursor uses, without a `table.` prefix
 * (lang-sql only completes columns after one). Ranked above table names.
 */
function columnSource(tree: SchemaTree | undefined, defaultSchema: string): CompletionSource {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const find = (schema: string | undefined, table: string) => {
    const schemas = tree?.schemas ?? [];
    const inSchema = (s?: (typeof schemas)[number]) => s?.relations.find((r) => r.name === table) ?? s?.relations.find((r) => same(r.name, table));
    if (schema) return inSchema(schemas.find((s) => s.name === schema) ?? schemas.find((s) => same(s.name, schema)));
    return inSchema(schemas.find((s) => s.name === defaultSchema)) ?? schemas.map((s) => inSchema(s)).find(Boolean);
  };
  return (ctx) => {
    if (!tree) return null;
    const word = ctx.matchBefore(/[\w$\u0080-\uffff]+/);
    if (!word && !ctx.explicit) return null;
    const from = word?.from ?? ctx.pos;
    // after `x.` lang-sql completes that table's columns itself
    if (ctx.state.sliceDoc(from - 1, from) === ".") return null;
    const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
    if (/String|Comment|QuotedIdentifier/.test(node.name)) return null;
    const doc = ctx.state.doc.toString();
    const stmt = statementAt(doc, ctx.pos) ?? statementAt(doc, from);
    const start = stmt && stmt.from <= from ? stmt.from : 0;
    if (expectsTable(doc.slice(start, from))) return null;
    const refs = tablesInStatement(stmt?.text ?? doc.slice(start));
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const r of refs) {
      const rel = find(r.schema, r.table);
      for (const c of rel?.columns ?? []) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        options.push({ label: c.name, type: "property", detail: `${c.dataType} · ${rel!.name}`, boost: 50 });
      }
    }
    return options.length ? { from, options, validFor: /^[\w$\u0080-\uffff]*$/ } : null;
  };
}

const language = (p: Pick<Props, "kind" | "product" | "schema" | "defaultSchema">) => {
  const defaultSchema = p.defaultSchema || "public";
  const support = sql({ dialect: dialectFor(p.kind, p.product), schema: namespace(p.schema), defaultSchema });
  return [support, support.language.data.of({ autocomplete: columnSource(p.schema, defaultSchema) })];
};

function currentSql(view: EditorView) {
  const { from, to, head } = view.state.selection.main;
  const doc = view.state.doc.toString();
  if (to > from) return { sql: doc.slice(from, to), offset: from };
  const s = statementAt(doc, head);
  return s ? { sql: s.text, offset: s.from } : null;
}

export const SqlEditor = forwardRef<SqlEditorHandle, Props>(function SqlEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const vimComp = useRef(new Compartment());
  const sqlComp = useRef(new Compartment());
  // latest callbacks without recreating the editor
  const cb = useRef(props);
  cb.current = props;

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    current: () => (view.current ? currentSql(view.current) : null),
    all: () => ({ sql: view.current?.state.doc.toString() ?? "", offset: 0 }),
    insert: (text) => {
      const v = view.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    },
  }));

  useEffect(() => {
    const run = (v: EditorView, which: "current" | "all") => {
      closeCompletion(v);
      const q = which === "all" ? { sql: v.state.doc.toString(), offset: 0 } : currentSql(v);
      if (q) cb.current.onRun(q.sql, q.offset);
      return true;
    };
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          // vim must come first so its keys win (filled in by the effect below)
          vimComp.current.of([]),
          Prec.highest(
            keymap.of([
              { key: "Mod-Enter", run: (v) => run(v, "current") },
              { key: "Shift-Mod-Enter", run: (v) => run(v, "all") },
              { key: "Mod-/", run: toggleComment },
            ]),
          ),
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: false }),
          highlightActiveLine(),
          highlightSelectionMatches(),
          placeholder("Write SQL…  Ctrl/⌘ Enter runs the statement under the cursor"),
          keymap.of([
            { key: "Tab", run: acceptCompletion },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          sqlComp.current.of(language(props)),
          syntaxHighlighting(highlight),
          theme,
          errorField,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    if (props.autoFocus) v.focus();
    return () => v.destroy();
    // created once; props are applied by the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // outside changes (e.g. "open in editor" from history)
  useEffect(() => {
    const v = view.current!;
    if (v.state.doc.toString() !== props.value)
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value } });
  }, [props.value]);

  useEffect(() => {
    const v = view.current!;
    if (!props.vim) {
      v.dispatch({ effects: vimComp.current.reconfigure([]) });
      cb.current.onVimMode?.("");
      return;
    }
    let cancelled = false;
    let cleanup = () => {};
    void loadVim().then(({ vim, getCM }) => {
      if (cancelled) return;
      v.dispatch({ effects: vimComp.current.reconfigure(vim()) });
      cb.current.onVimMode?.("normal");
      const cm = getCM(v);
      const onMode = (e: { mode: string; subMode?: string }) =>
        cb.current.onVimMode?.(e.subMode ? `${e.mode} ${e.subMode}` : e.mode);
      cm?.on("vim-mode-change", onMode);
      cleanup = () => cm?.off("vim-mode-change", onMode);
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [props.vim]);

  useEffect(() => {
    view.current!.dispatch({ effects: sqlComp.current.reconfigure(language(props)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.schema, props.kind, props.product, props.defaultSchema]);

  useEffect(() => {
    const v = view.current!;
    const range = props.errorRange
      ? { from: Math.min(props.errorRange.from, v.state.doc.length), to: Math.min(props.errorRange.to, v.state.doc.length) }
      : null;
    v.dispatch({
      effects: [setError.of(range), ...(range ? [EditorView.scrollIntoView(range.from, { y: "center" })] : [])],
    });
  }, [props.errorRange]);

  return <div ref={host} className="editor" />;
});
