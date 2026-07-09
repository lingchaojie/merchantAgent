import { MOCK_USERS } from "../types";
import { IconUser } from "./icons";

export function TopBar({
  title,
  userId,
  onCommand,
}: {
  title: string;
  userId: string;
  onCommand: () => void;
}): JSX.Element {
  const user = MOCK_USERS.find((u) => u.id === userId);
  return (
    <header className="topbar">
      <div className="topbar-title">{title}</div>
      <div className="topbar-right">
        <span className="ident-chip" title="当前身份（权限来源）">
          <IconUser width={13} height={13} />
          {user?.name} · {user?.roleLabel}
        </span>
        <button className="kbd-btn" onClick={onCommand} title="命令面板">
          <kbd>⌘</kbd><kbd>K</kbd>
        </button>
      </div>
    </header>
  );
}
