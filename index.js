


const express = require("express");
const fetch = require("node-fetch");

const app = express();
const userSessions = {};


// VARIABLES
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// MIDDLEWARE
app.use(express.json());

// RUTA DE PRUEBA
app.get("/", (req, res) => {
  res.send("Bot activo 🚀");
});

// VERIFICACIÓN WEBHOOK
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

// RECIBIR MENSAJES
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const text = message.text?.body?.trim().toLowerCase();

    if (!userSessions[from]) {
      userSessions[from] = {
        step: "start",
        order: {}
      };
    }

    const session = userSessions[from];
    let reply = "";

    console.log("➡️ Paso:", session.step);
    console.log("📩 Mensaje:", text);

    switch (session.step) {
      case "start":
        reply = `🍕 Bienvenido a Pizzería Villa

¿Qué pizza deseas?
Ejemplo:
- Pepperoni
- Hawaiana
- Mitad Pepperoni / Mitad Jamón`;
        session.step = "pizza";
        break;

      case "pizza":
        session.order.pizza = text;
        reply = "📏 ¿Qué tamaño?\nChica / Mediana / Grande";
        session.step = "size";
        break;

      case "size":
        session.order.size = text;
        reply = "🧀 ¿Extras?\nNinguno / Orilla de queso / Extra queso";
        session.step = "extras";
        break;

      case "extras":
        session.order.extras = text;
        reply = "🔢 ¿Cuántas pizzas?";
        session.step = "quantity";
        break;

      case "quantity":
        session.order.quantity = text;
        reply = "📍 Escribe tu dirección completa";
        session.step = "address";
        break;

      case "address":
        session.order.address = text;
        reply = "📞 Escribe tu número de teléfono";
        session.step = "phone";
        break;

      case "phone":
        session.order.phone = text;

        reply = `
🧾 PEDIDO CONFIRMADO

🍕 Pizza: ${session.order.pizza}
📏 Tamaño: ${session.order.size}
🧀 Extras: ${session.order.extras}
🔢 Cantidad: ${session.order.quantity}

📍 Dirección:
${session.order.address}

📞 Teléfono:
${session.order.phone}

🙏 Gracias por tu pedido
Tiempo estimado: 35 minutos
`;

        delete userSessions[from];
        break;
    }

    await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply },
      }),
    });

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Error:", error);
    res.sendStatus(500);
  }
});

// SERVIDOR
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
