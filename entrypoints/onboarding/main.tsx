import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OnboardingApp from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OnboardingApp />
  </StrictMode>,
);
