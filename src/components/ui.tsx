/** Small shared pieces: modal, menus, keyboard hints, clipboard. */
import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../lib/store";

export async function copyText(text: string, label = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // older webviews without async clipboard
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  useApp.getState().toast(label);
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Elements that can take focus inside a container, in tab order. */
const focusables = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
    (x) => !x.hasAttribute("disabled") && x.offsetParent !== null,
  );

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 480,
  className = "",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    // focus the first field, not the close button
    const first = focusables(el).find((x) => !x.classList.contains("modal-close"));
    (first ?? el).focus();
    return () => prev?.focus?.();
  }, []);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`modal ${className}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={(e) => {
          // React events bubble out of portals: keep keys from reaching the grid behind
          e.stopPropagation();
          if (e.key === "Escape") {
            onClose();
          } else if (e.key === "Tab") {
            // keep focus inside the dialog
            const list = focusables(ref.current!);
            if (!list.length) return;
            const i = list.indexOf(document.activeElement as HTMLElement);
            if (e.shiftKey && i <= 0) {
              e.preventDefault();
              list.at(-1)!.focus();
            } else if (!e.shiftKey && i === list.length - 1) {
              e.preventDefault();
              list[0].focus();
            }
          }
        }}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn modal-close" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Menu at a screen point (context menus and "…" buttons). Arrow keys / j k move, Enter picks. */
export function Menu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: (MenuItem | "divider")[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [active, setActive] = useState(-1);
  const real = items.map((it, i) => (it === "divider" || it.disabled ? -1 : i)).filter((i) => i >= 0);

  // captured at first render, before the menu takes focus; given back on close (e.g. to the grid)
  const [prev] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => prev?.focus?.({ preventScroll: true }), [prev]);

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 8),
      y: y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y,
    });
    ref.current!.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const pick = (i: number) => {
    const it = items[i];
    if (it && it !== "divider" && !it.disabled) {
      onClose();
      it.onSelect();
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const k = e.key;
        if (k === "Escape") onClose();
        else if (k === "ArrowDown" || k === "j") {
          e.preventDefault();
          setActive(real[(real.indexOf(active) + 1) % real.length]);
        } else if (k === "ArrowUp" || k === "k") {
          e.preventDefault();
          setActive(real[(real.indexOf(active) - 1 + real.length) % real.length]);
        } else if (k === "Enter" && active >= 0) {
          e.preventDefault();
          pick(active);
        }
      }}
    >
      {items.map((it, i) =>
        it === "divider" ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={`menu-item ${it.danger ? "danger" : ""} ${i === active ? "active" : ""}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(i)}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem | "divider")[] } | null>(null);
  const element = menu && <Menu {...menu} onClose={() => setMenu(null)} />;
  return { open: (x: number, y: number, items: (MenuItem | "divider")[]) => setMenu({ x, y, items }), element };
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
