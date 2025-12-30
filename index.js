import express from "express";

const app = express();

// Para leer JSON de Meta
app.use(express.json());

// 👉 Verificación de Meta (GET)
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("MODE:", mode);
  console.log("TOKEN:", token);
  console.log("VERIFY_TOKEN:", VERIFY_TOKEN);
  console.log("CHALLENGE:", challenge);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge.toString());
  } else {
    console.log("❌ Verificación fallida");
    return res.sendStatus(403);
  }
});

// 👉 Mensajes entrantes (POST)
app.post("/webhook", (req, res) => {
  console.log("🔥 WEBHOOK HIT");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// 👉 Puerto para Railway
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
