import { useState, useRef, useEffect, type KeyboardEvent } from "react";
import { IconSend } from "./icons";

// Auto-growing textarea composer. Enter sends; Shift+Enter inserts a newline.
export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (q: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // Auto-resize to content (capped by CSS max-height).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text]);

  const submit = () => {
    const q = text.trim();
    if (!q || disabled) return;
    onSend(q);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="问订单进度 / 齐套 / 利润…  （Enter 发送，Shift+Enter 换行）"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <button className="send-btn" disabled={disabled || !text.trim()} onClick={submit} title="发送">
          <IconSend width={16} height={16} />
        </button>
      </div>
    </div>
  );
}
