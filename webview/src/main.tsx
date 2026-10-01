import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./fonts/sarasa-mono-sc/regular/result.css";
import "./fonts/sarasa-mono-sc/semibold/result.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
