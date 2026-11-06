// Fixture embed worker: answers every request with a worker-side EmbedError.
process.on("message", (req) => {
  process.send({
    id: req.id,
    ok: false,
    error: { message: "model files missing", kind: "model-missing", hint: "Run the download" },
  });
});
process.on("disconnect", () => process.exit(0));
