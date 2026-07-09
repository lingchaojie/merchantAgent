// Makes window.agent typed in the renderer, bound to the shared contract.
import type { AgentAPI } from "../../shared/contract";

declare global {
  interface Window {
    agent: AgentAPI;
  }
}

export {};
