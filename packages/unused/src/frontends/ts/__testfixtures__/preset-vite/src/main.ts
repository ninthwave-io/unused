// Only reachable because index.html's <script src="/src/main.ts"> seeds this
// file as a production entrypoint (the vite preset's index.html carrier,
// T4.4 item 2) — nothing else in the project references it.
import { mount } from "./app.js";

mount();
