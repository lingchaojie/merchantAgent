// Preload runs in an isolated context and is the ONLY thing the renderer sees of
// the main process. It exposes a tiny, typed API via contextBridge — the
// renderer gets no ipcRenderer, no require, no Node globals. The exposed object
// is typed as AgentAPI, so preload and renderer can't drift from the contract.
import { contextBridge, ipcRenderer } from "electron";
import { Channels, type AgentAPI, type ChatEvent } from "../shared/contract";

const api: AgentAPI = {
  login: (userId) => ipcRenderer.invoke(Channels.login, { userId }),

  // chat: subscribe to a per-call event channel, forward events to onEvent, and
  // resolve with the final text when the invoke completes. Listener is cleaned
  // up on completion so streams never leak.
  chat: (req, onEvent) => {
    const streamId = crypto.randomUUID();
    const chan = Channels.chatEventPrefix + streamId;
    const listener = (_e: unknown, ev: ChatEvent) => onEvent(ev);
    ipcRenderer.on(chan, listener);
    return ipcRenderer
      .invoke(Channels.chat, { streamId, req })
      .finally(() => ipcRenderer.removeListener(chan, listener)) as Promise<string>;
  },

  readFile: (rel) => ipcRenderer.invoke(Channels.fsRead, { rel }),
  writeFile: (rel, contents, confirmed) =>
    ipcRenderer.invoke(Channels.fsWrite, { rel, contents, confirmed }),

  admin: (req) => ipcRenderer.invoke(Channels.admin, req),
};

contextBridge.exposeInMainWorld("agent", api);
