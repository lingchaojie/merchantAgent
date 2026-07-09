import { useMemo, useState, useEffect, useRef } from "react";
import { MOCK_USERS } from "../types";
import { IconPlus, IconUser } from "./icons";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  icon: JSX.Element;
  run: () => void;
}

export function CommandPalette({
  userId,
  onClose,
  onPickUser,
  onNewThread,
}: {
  userId: string;
  onClose: () => void;
  onPickUser: (id: string) => void;
  onNewThread: () => void;
}): JSX.Element {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [
      { id: "new", label: "新建会话", icon: <IconPlus width={15} height={15} />, run: () => { onNewThread(); onClose(); } },
    ];
    for (const u of MOCK_USERS) {
      list.push({
        id: "user-" + u.id,
        label: `切换身份：${u.name}`,
        hint: u.roleLabel + (u.id === userId ? " · 当前" : ""),
        icon: <IconUser width={15} height={15} />,
        run: () => { onPickUser(u.id); onClose(); },
      });
    }
    return list;
  }, [userId, onPickUser, onNewThread, onClose]);

  const filtered = useMemo(
    () => cmds.filter((c) => (c.label + (c.hint ?? "")).toLowerCase().includes(q.toLowerCase())),
    [cmds, q],
  );

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return onClose();
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    if (e.key === "Enter") { e.preventDefault(); filtered[sel]?.run(); }
  };

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="输入命令…（切换身份 / 新建会话）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={"palette-item" + (i === sel ? " active" : "")}
              onMouseEnter={() => setSel(i)}
              onClick={c.run}
            >
              <span className="palette-icon">{c.icon}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </button>
          ))}
          {filtered.length === 0 && <div className="palette-empty">无匹配命令</div>}
        </div>
      </div>
    </div>
  );
}
