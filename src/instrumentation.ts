export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartup } = await import("./server/startup");
    await runStartup();
    // Not awaited: register() must return before the server serves.
    const { startInProcessLoop } = await import("./server/scheduler/in-process");
    startInProcessLoop();
  }
}
