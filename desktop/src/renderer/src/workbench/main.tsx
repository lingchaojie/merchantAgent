import React from "react";
import { createRoot } from "react-dom/client";

import type { WorkbenchAPI } from "../../../shared/connector-contract";
import "../theme.css";
import "./workbench.css";
import { WorkbenchApp } from "./WorkbenchApp";

const api = (window as unknown as { workbench: WorkbenchAPI }).workbench;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WorkbenchApp api={api} />
  </React.StrictMode>,
);
