import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/shell.css";
import "./styles/accounts.css";
import "./styles/meetings.css";
import "./styles/dashboard.css";
import "./styles/tasks.css";
import "./styles/admin.css";
import "./styles/setup.css";
import "./styles/platform.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);
if (import.meta.env.DEV && new URLSearchParams(location.search).has("harness")) {
  import("./dev/Harness").then(({ default: Harness }) => root.render(<Harness />));
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
