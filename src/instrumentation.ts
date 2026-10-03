export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartup } = await import("./server/startup");
    await runStartup();
  }
}
