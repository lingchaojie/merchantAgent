import { MOCK_USERS } from "../types";
import { IconUser } from "./icons";

export function TopBar({
  title,
  userId,
  onCommand,
  view,
  onToggleView,
  canAdmin,
}: {
  title: string;
  userId: string;
  onCommand: () => void;
  view: "chat" | "admin";
  onToggleView: () => void;
  canAdmin: boolean | null;
}): JSX.Element {
  const user = MOCK_USERS.find((u) => u.id === userId);
  const returningToChat = view === "admin";
  const adminDisabled = !returningToChat && canAdmin !== true;
  const adminTitle = returningToChat
    ? "返回聊天"
    : canAdmin === null ? "正在检查管理员权限" : canAdmin ? "管理配置" : "需要管理员身份";
  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        <span className="ident-chip" title="当前身份（权限来源）">
          <IconUser width={13} height={13} />
          {user?.name} · {user?.roleLabel}
        </span>
        <button className="kbd-btn" onClick={onToggleView} title={adminTitle} disabled={adminDisabled}>
          {view === "chat" ? "⚙ 配置" : "← 聊天"}
        </button>
        <button className="kbd-btn" onClick={onCommand} title="命令面板">
          <kbd>⌘</kbd><kbd>K</kbd>
        </button>
      </div>
    </header>
  );
}
