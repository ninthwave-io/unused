import { handlers } from "./handlers.js";

function setupWorker(...registeredHandlers: readonly unknown[]) {
  return registeredHandlers.length;
}

setupWorker(...handlers);
