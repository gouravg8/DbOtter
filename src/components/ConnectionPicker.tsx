import { ChevronDown, Database } from "lucide-react";
import { useRef } from "react";
import { useApp } from "../lib/store";
import { useMenu } from "./ui";

/** Which connection a query tab runs against. */
export function ConnectionPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const connections = useApp((s) => s.connections);
  const sessions = useApp((s) => s.sessions);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useMenu();
  const current = connections.find((c) => c.id === value);

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="btn picker"
        onClick={() => {
          const r = btn.current!.getBoundingClientRect();
          menu.open(
            r.left,
            r.bottom + 4,
            connections.length
              ? connections.map((c) => ({
                  label: c.name,
                  hint: sessions[c.id]?.status === "connected" ? "connected" : undefined,
                  icon: <span className="dot" style={{ background: c.color ?? "var(--subtle)" }} />,
                  onSelect: () => onChange(c.id),
                }))
              : [{ label: "No connections yet", disabled: true, onSelect: () => {} }],
          );
        }}
      >
        {current ? (
          <span className="dot" style={{ background: current.color ?? "var(--subtle)" }} />
        ) : (
          <Database size={14} />
        )}
        <span className="picker-label">{current?.name ?? "Choose connection"}</span>
        <ChevronDown size={13} />
      </button>
      {menu.element}
    </>
  );
}
