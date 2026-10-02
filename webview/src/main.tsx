import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./fonts/sarasa-mono-sc/regular/result.css";
import "./fonts/sarasa-mono-sc/bold/result.css";
import "./fonts/sarasa-mono-sc/italic/result.css";
import "./fonts/sarasa-mono-sc/bold-italic/result.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
