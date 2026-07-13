import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.tsx";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("WEB_ROOT_MISSING");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
