// Fixture embed worker: dies with exit code 5 (the V8-fatal code from #117) on the first request.
process.on("message", () => process.exit(5));
