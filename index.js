import express from "express";

const app = express();

// 👇 IMPORTANTE: para leer JSON de Meta
app.use(express.json());

// 👉 Webhook de Meta (POST)
app.post("/webhook", (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// 👉 Verificación de Meta (GET)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// 👉 Puerto para Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo y funcionando${PORT}`);
});
