// Fixture embed worker: answers each text with [text.length, first char code].
// Texts starting with "slow" are answered after 150ms, so replies arrive out of order.
process.on("message", (req) => {
  const reply = () => {
    if (req.op === "embed") {
      const vectors = req.texts.map((t) => [t.length, t.charCodeAt(0)]);
      process.send({ id: req.id, ok: true, vectors });
    } else if (req.op === "health") {
      process.send({ id: req.id, ok: true, health: { ok: true, detail: "echo" } });
    } else {
      process.send({ id: req.id, ok: true });
    }
  };
  const slow = req.op === "embed" && req.texts.some((t) => t.startsWith("slow"));
  if (slow) setTimeout(reply, 150);
  else reply();
});
process.on("disconnect", () => process.exit(0));
console.error("echo worker started");
