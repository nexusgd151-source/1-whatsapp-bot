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
    const messageType = message.type;
    const text = message.text?.body?.trim();
    const buttonText = message.button?.text;

    if (!userSessions[from]) {
      userSessions[from] = {
        step: "start",
        order: {}
      };
    }

    const session = userSessions[from];
    let replyPayload = null;

    console.log("➡️ Paso:", session.step);
    console.log("📩 Tipo:", messageType, "Contenido:", text || buttonText);

    switch (session.step) {

      case "start":
        replyPayload = interactiveButtons(
          "🍕 Bienvenido a *Pizzería Villa*\n¿Qué pizza deseas?",
          ["Pepperoni", "Hawaiana", "Mitad / Mitad"]
        );
        session.step = "pizza";
        break;

      case "pizza":
        if (messageType !== "button") {
          replyPayload = textMessage("❌ Usa los botones para elegir la pizza.");
          break;
        }
        session.order.pizza = buttonText;
        session.step = "size";
        replyPayload = interactiveButtons(
          "📏 Elige el tamaño:",
          ["Chica", "Mediana", "Grande"]
        );
        break;

      case "size":
        if (messageType !== "button") {
          replyPayload = textMessage("❌ Usa los botones para elegir el tamaño.");
          break;
        }
        session.order.size = buttonText;
        session.step = "extras";
        replyPayload = interactiveButtons(
          "🧀 ¿Extras?",
          ["Ninguno", "Orilla de queso", "Extra queso"]
        );
        break;

      case "extras":
        if (messageType !== "button") {
          replyPayload = textMessage("❌ Usa los botones para elegir los extras.");
          break;
        }
        session.order.extras = buttonText;
        session.step = "address";
        replyPayload = textMessage(
          "📍 Escribe tu *dirección completa* (calle, número y colonia):"
        );
        break;

      case "address":
        if (messageType !== "text") {
          replyPayload = textMessage("❌ Aquí debes escribir tu dirección.");
          break;
        }
        session.order.address = text;
        session.step = "phone";
        replyPayload = textMessage("📞 Escribe tu *número de teléfono*:");
        break;

      case "phone":
        if (messageType !== "text") {
          replyPayload = textMessage("❌ Aquí debes escribir tu número.");
          break;
        }
        session.order.phone = text;

        replyPayload = textMessage(
`🧾 *PEDIDO CONFIRMADO*

🍕 Pizza: ${session.order.pizza}
📏 Tamaño: ${session.order.size}
🧀 Extras: ${session.order.extras}

📍 Dirección:
${session.order.address}

📞 Teléfono:
${session.order.phone}

⏱ Tiempo estimado: 35 minutos
🙏 ¡Gracias por tu pedido!`
        );

        delete userSessions[from];
        break;
    }

    if (replyPayload) {
      await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          ...replyPayload,
        }),
      });
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Error:", error);
    res.sendStatus(500);
  }
});

// FUNCIONES AUXILIARES
function textMessage(body) {
  return {
    type: "text",
    text: { body }
  };
}

function interactiveButtons(text, options) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: options.map(opt => ({
          type: "reply",
          reply: { id: opt.toLowerCase(), title: opt }
        }))
      }
    }
  };
}

// SERVIDOR
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
