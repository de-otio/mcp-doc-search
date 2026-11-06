// Fixture embed worker: answers its first request, then never answers again.
let n = 0;
process.on("message", (req) => {
  n += 1;
  if (n === 1) process.send({ id: req.id, ok: true, vectors: [[1, 1]] });
});
process.on("disconnect", () => process.exit(0));
