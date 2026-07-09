// Preload runs in an isolated context and is the ONLY thing the renderer sees of
// the main process. It exposes a tiny, typed API via contextBridge — the
// renderer gets no ipcRenderer, no require, no Node globals. The exposed object
// is typed as AgentAPI, so preload and renderer can't drift from the contract.
import { contextBridge, ipcRenderer } from "electron";
import { Channels, type AgentAPI } from "../shared/contract";

const api: AgentAPI = {
  login: (userId) => ipcRenderer.invoke(Channels.login, { userId }),
  ask: (tenantId, userId, question) =>
    ipcRenderer.invoke(Channels.ask, { tenantId, userId, question }),
  readFile: (rel) => ipcRenderer.invoke(Channels.fsRead, { rel }),
  writeFile: (rel, contents, confirmed) =>
    ipcRenderer.invoke(Channels.fsWrite, { rel, contents, confirmed }),
};

contextBridge.exposeInMainWorld("agent", api);
