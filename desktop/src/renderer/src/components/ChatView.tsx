import { useEffect, useRef } from "react";
import type { Message } from "../types";
import { ResultCard } from "./ResultCard";
import { EmptyState } from "./EmptyState";
import { IconLock, IconSparkle } from "./icons";

// Maps a backend tool name to a short human badge.
const TOOL_LABEL: Record<string, string> = {
  query_order_status: "订单进度",
  query_order_financials: "订单财务",
  check_material_kitting: "齐套检查",
};

function TypingDots(): JSX.Element {
  return (
    <span className="typing">
      <span></span><span></span><span></span>
    </span>
  );
}

function MessageRow({ m }: { m: Message }): JSX.Element {
  const isUser = m.role === "user";
  return (
    <div className={"row " + m.role}>
      <div className="avatar">{isUser ? "你" : <IconSparkle width={15} height={15} />}</div>
      <div className="row-body">
        <div className="row-meta">
          <span className="row-who">{isUser ? "我" : "Agent"}</span>
          {m.tool && !m.denied && <span className="tool-badge">{TOOL_LABEL[m.tool] ?? m.tool}</span>}
          {m.denied && <span className="tool-badge denied"><IconLock width={11} height={11} /> 权限拦截</span>}
        </div>
        {m.pending ? (
          <TypingDots />
        ) : (
          <div className={"bubble" + (m.denied ? " denied" : "")}>{m.text}</div>
        )}
        {!m.pending && <ResultCard tool={m.tool} data={m.data} />}
      </div>
    </div>
  );
}

export function ChatView({
  messages,
  onExample,
}: {
  messages: Message[];
  onExample: (q: string) => void;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="chat">
        <EmptyState onPick={onExample} />
      </div>
    );
  }

  return (
    <div className="chat">
      <div className="chat-inner">
        {messages.map((m) => (
          <MessageRow key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
