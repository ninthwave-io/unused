export async function startApplication() {
  await navigator.serviceWorker.register("/runtime-worker.js");
}

startApplication();
