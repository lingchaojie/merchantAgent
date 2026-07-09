import { IconPlus, IconMessage, IconSparkle } from "./icons";
import { MOCK_USERS, type Thread } from "../types";
import { IS_MOCK } from "../agent";

export function Sidebar({
  threads,
  activeId,
  userId,
  onSelect,
  onNew,
  onPickUser,
}: {
  threads: Thread[];
  activeId: string;
  userId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onPickUser: (id: string) => void;
}): JSX.Element {
  const user = MOCK_USERS.find((u) => u.id === userId);
  return (
    <aside className="sidebar">
      <div className="side-head">
        <div className="brand">
          <span className="brand-mark"><IconSparkle width={13} height={13} /></span>
          merchantAgent
        </div>
        <button className="icon-btn" title="新会话" onClick={onNew}>
          <IconPlus />
        </button>
      </div>

      <nav className="thread-list">
        {threads.map((t) => (
          <button
            key={t.id}
            className={"thread-item" + (t.id === activeId ? " active" : "")}
            onClick={() => onSelect(t.id)}
          >
            <IconMessage width={14} height={14} />
            <span className="thread-title">{t.title}</span>
          </button>
        ))}
      </nav>

      <div className="side-foot">
        <label className="ident">
          <span className="ident-avatar">{user?.name.slice(0, 1) ?? "?"}</span>
          <span className="ident-meta">
            <span className="ident-name">{user?.name}</span>
            <span className="ident-role">{user?.roleLabel}</span>
          </span>
          <select className="ident-select" value={userId} onChange={(e) => onPickUser(e.target.value)}>
            {MOCK_USERS.map((u) => (
              <option key={u.id} value={u.id}>{u.name} · {u.roleLabel}</option>
            ))}
          </select>
        </label>
        {IS_MOCK && <div className="mock-tag">浏览器预览（mock 数据）</div>}
      </div>
    </aside>
  );
}
