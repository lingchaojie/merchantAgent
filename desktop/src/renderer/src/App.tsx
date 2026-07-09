import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { CommandPalette } from "./components/CommandPalette";
import { getAgent } from "./agent";
import { foldEvent, type Thread, type Message } from "./types";
import type { ChatEvent } from "../../shared/contract";

const agent = getAgent();

function newThread(): Thread {
  return {
    id: crypto.randomUUID(),
    title: "新会话",
    sessionId: crypto.randomUUID(),
    messages: [],
    createdAt: Date.now(),
  };
}

export function App(): JSX.Element {
  const [threads, setThreads] = useState<Thread[]>([newThread()]);
  const [activeId, setActiveId] = useState(threads[0].id);
  const [userId, setUserId] = useState("u_sales1");
  const [busy, setBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const active = threads.find((t) => t.id === activeId) ?? threads[0];

  // Cmd/Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const patch = useCallback(
    (id: string, fn: (t: Thread) => Thread) =>
      setThreads((ts) => ts.map((t) => (t.id === id ? fn(t) : t))),
    [],
  );

  const send = useCallback(
    async (question: string) => {
      const userMsg: Message = { id: crypto.randomUUID(), role: "user", text: question, ts: Date.now() };
      const pendingId = crypto.randomUUID();
      const pending: Message = { id: pendingId, role: "assistant", text: "", pending: true, ts: Date.now() };
      const thread = threads.find((t) => t.id === activeId) ?? threads[0];
      patch(activeId, (t) => ({
        ...t,
        title: t.messages.length === 0 ? question.slice(0, 24) : t.title,
        messages: [...t.messages, userMsg, pending],
      }));
      setBusy(true);

      // Fold each streamed event into the pending assistant message live.
      const onEvent = (e: ChatEvent): void => {
        patch(activeId, (t) => ({
          ...t,
          messages: t.messages.map((m) => (m.id === pendingId ? foldEvent(m, e) : m)),
        }));
      };
      try {
        await agent.chat({ sessionId: thread.sessionId, userId, question }, onEvent);
      } catch (e) {
        const text = "错误：" + (e instanceof Error ? e.message : String(e));
        patch(activeId, (t) => ({
          ...t,
          messages: t.messages.map((m) => (m.id === pendingId ? { ...m, text, pending: false, denied: true, status: undefined } : m)),
        }));
      } finally {
        // Safety net: if no final/done arrived, clear the pending flag.
        patch(activeId, (t) => ({
          ...t,
          messages: t.messages.map((m) => (m.id === pendingId && m.pending ? { ...m, pending: false, status: undefined } : m)),
        }));
        setBusy(false);
      }
    },
    [activeId, userId, patch, threads],
  );

  const createThread = useCallback(() => {
    const t = newThread();
    setThreads((ts) => [t, ...ts]);
    setActiveId(t.id);
  }, []);

  return (
    <div className="layout">
      <Sidebar
        threads={threads}
        activeId={activeId}
        userId={userId}
        onSelect={setActiveId}
        onNew={createThread}
        onPickUser={setUserId}
      />
      <main className="main">
        <TopBar title={active.title} userId={userId} onCommand={() => setPaletteOpen(true)} />
        <ChatView messages={active.messages} onExample={send} />
        <Composer disabled={busy} onSend={send} />
      </main>
      {paletteOpen && (
        <CommandPalette
          userId={userId}
          onClose={() => setPaletteOpen(false)}
          onPickUser={setUserId}
          onNewThread={createThread}
        />
      )}
    </div>
  );
}
