const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ====================
// KEEP ALIVE (Railway)
// ====================
setInterval(() => {
  console.log("🫀 Alive");
}, 30000);

// ====================
// VARIABLES
// ====================

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ====================
// SESIONES
// ====================
const sessions = {};

// ====================
// PRECIOS
// ====================
const PRICES = {
  grande: 150,
  extragrande: 190,
  orilla: 40,
  extra: 15,
  envio: 40
};

// ====================
// RUTA TEST
// ====================
app.get("/", (req, res) => {
  res.send("Bot activo 🚀");
});

// ====================
// WEBHOOK VERIFY
// ====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ====================
// WEBHOOK MENSAJES
// ====================
app.post("/webhook", async (req, res) => {
    console.log("🔥 WEBHOOK DISPARADO");
  console.log(JSON.stringify(req.body, null, 2));
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];
    const from = message.from;
    const type = message.type;

    let text = null;
    let button = null;

    if (type === "text") {
      text = message.text.body;
    }

    if (
      type === "interactive" &&
      message.interactive?.button_reply
    ) {
      button = message.interactive.button_reply.title;
    }

    console.log("📩 Mensaje:", type, text || button);

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: [],
        currentPizza: null
      };
    }

    const session = sessions[from];
    let reply = null;

    switch (session.step) {

      case "menu":
        reply = buttons(
          "🍕 Bienvenido a *Pizzería Villa*\n¿Qué deseas hacer?",
          ["📖 Menú", "🛒 Realizar pedido", "❌ Cancelar"]
        );
        session.step = "menu_option";
        break;

      case "menu_option":
        if (!button) {
          reply = textMsg("❌ Usa los botones.");
          break;
        }

        if (button.includes("pedido")) {
          session.step = "pizza_type";
          session.currentPizza = { extras: [] };
          reply = buttons(
            "🍕 ¿Qué pizza deseas?",
            ["Pepperoni", "Carnes frías", "Hawaiana", "Mexicana"]
          );
        } else {
          reply = textMsg("👋 Gracias por visitarnos.");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        if (!button) {
          reply = textMsg("❌ Usa botones.");
          break;
        }
        session.currentPizza.type = button;
        session.step = "size";
        reply = buttons(
          "📏 Elige tamaño:",
          ["Grande (8 rebanadas)", "Extra grande (10 rebanadas)"]
        );
        break;

      case "size":
        if (!button) {
          reply = textMsg("❌ Usa botones.");
          break;
        }
        session.currentPizza.size = button;
        session.step = "crust";
        reply = buttons(
          "🧀 ¿Agregar orilla de queso? (+$40)",
          ["Sí", "No"]
        );
        break;

      case "crust":
        if (!button) {
          reply = textMsg("❌ Usa botones.");
          break;
        }
        session.currentPizza.crust = button === "Sí";
        session.step = "extras";
        reply = buttons(
          "➕ Extras ($15 c/u)",
          ["Pepperoni", "Jamón", "Jalapeño", "Piña", "Chorizo", "Queso", "Tocino", "Ninguno"]
        );
        break;

      case "extras":
        if (!button) {
          reply = textMsg("❌ Usa botones.");
          break;
        }

        if (button !== "Ninguno") {
          session.currentPizza.extras.push(button);
          session.step = "more_extras";
          reply = buttons(
            `✅ ${button} agregado\n¿Agregar otro extra?`,
            ["Sí", "No"]
          );
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "another_pizza";
          reply = buttons(
            "🍕 ¿Deseas agregar otra pizza?",
            ["Sí", "No"]
          );
        }
        break;

      case "more_extras":
        if (button === "Sí") {
          session.step = "extras";
          reply = buttons(
            "➕ Extras ($15 c/u)",
            ["Pepperoni", "Jamón", "Jalapeño", "Piña", "Chorizo", "Queso", "Tocino", "Ninguno"]
          );
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "another_pizza";
          reply = buttons(
            "🍕 ¿Agregar otra pizza?",
            ["Sí", "No"]
          );
        }
        break;

      case "another_pizza":
        if (button === "Sí") {
          session.currentPizza = { extras: [] };
          session.step = "pizza_type";
          reply = buttons(
            "🍕 ¿Qué pizza deseas?",
            ["Pepperoni", "Carnes frías", "Hawaiana", "Mexicana"]
          );
        } else {
          session.step = "address";
          reply = textMsg("📍 Escribe tu dirección completa:");
        }
        break;

      case "address":
        session.address = text;
        session.step = "phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "phone":
        session.phone = text;

        let total = 0;
        let summary = "🆕 *NUEVO PEDIDO 🍕*\n\n";

        session.pizzas.forEach((p, i) => {
          const sizePrice = p.size.includes("Extra")
            ? PRICES.extragrande
            : PRICES.grande;

          total += sizePrice;
          if (p.crust) total += PRICES.orilla;
          total += p.extras.length * PRICES.extra;

          summary += `🍕 *Pizza ${i + 1}*\n• ${p.type}\n• ${p.size}\n`;
          if (p.crust) summary += `• Orilla (+$${PRICES.orilla})\n`;
          if (p.extras.length)
            summary += `• Extras: ${p.extras.join(", ")} (+$${p.extras.length * PRICES.extra})\n`;
          summary += "\n";
        });

        total += PRICES.envio;

        summary += `🚚 Envío: $${PRICES.envio}\n💰 *TOTAL:* $${total} MXN\n\n📍 ${session.address}\n📞 ${session.phone}`;

        reply = textMsg(summary);
        delete sessions[from];
        break;
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error:", err);
    res.sendStatus(500);
  }
});

// ====================
// HELPERS
// ====================
function textMsg(body) {
  return { type: "text", text: { body } };
}

function buttons(text, options) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: options.map(o => ({
          type: "reply",
          reply: { id: o, title: o }
        }))
      }
    }
  };
}

async function sendMessage(to, payload) {
  await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      ...payload
    })
  });
}

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bot corriendo correctamente en puerto ${PORT}`);
});
