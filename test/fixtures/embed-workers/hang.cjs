// Fixture embed worker: reads requests and never answers.
process.on("message", () => {});
process.on("disconnect", () => process.exit(0));
