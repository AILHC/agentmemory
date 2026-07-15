const mode = process.argv[2] ?? "hold";

if (mode === "exit") {
  process.exit(17);
}

process.on("message", (message) => {
  if (message?.type === "agentmemory:shutdown") process.exit(0);
});

setInterval(() => undefined, 1_000);
