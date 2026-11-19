import { render } from "preact";
import { App } from "./app.tsx";
import { applyTheme, loadTheme } from "./theme.ts";
import "./style.css";

applyTheme(loadTheme());
render(<App />, document.getElementById("root")!);
