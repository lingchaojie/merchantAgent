import { useState, useCallback, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { CommandPalette } from "./components/CommandPalette";
import { getAgent } from "./agent";
import { answerToMessage, type Thread, type Message } from "./types";

const TENANT = "mock-corp-001";
const agent = getAgent();

function newThread(): Thread {
  return { id: crypto.randomUUID(), title: "新会话", messages: [], createdAt: Date.now() };
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
      const pending: Message = { id: crypto.randomUUID(), role: "assistant", text: "", pending: true, ts: Date.now() };
      patch(activeId, (t) => ({
        ...t,
        title: t.messages.length === 0 ? question.slice(0, 24) : t.title,
        messages: [...t.messages, userMsg, pending],
      }));
      setBusy(true);
      try {
        const ans = await agent.ask(TENANT, userId, question);
        const msg = answerToMessage(ans);
        patch(activeId, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === pending.id ? msg : m)) }));
      } catch (e) {
        const text = "错误：" + (e instanceof Error ? e.message : String(e));
        patch(activeId, (t) => ({
          ...t,
          messages: t.messages.map((m) => (m.id === pending.id ? { ...m, text, pending: false, denied: true } : m)),
        }));
      } finally {
        setBusy(false);
      }
    },
    [activeId, userId, patch],
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
