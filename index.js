const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ====================
// VARIABLES DE ENTORNO
// ====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ====================
// SESIONES EN MEMORIA
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
  return res.sendStatus(403);
});

// ====================
// WEBHOOK MENSAJES
// ====================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];
    const from = message.from;
    const type = message.type;

    let input = null;

    if (type === "text") input = message.text.body;
    if (type === "interactive") {
      if (message.interactive.button_reply) {
        input = message.interactive.button_reply.title;
      }
      if (message.interactive.list_reply) {
        input = message.interactive.list_reply.id;
      }
    }

    // Crear sesión si no existe
    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: [],
        currentPizza: null
      };
    }

    const session = sessions[from];
    let reply = null;

    // ====================
    // FLUJO
    // ====================
    switch (session.step) {

      case "menu":
        reply = buttons(
          "🍕 *Bienvenido a Pizzería Villa*\n¿Qué deseas hacer?",
          ["📖 Ver menú", "🛒 Realizar pedido", "❌ Cancelar"]
        );
        session.step = "menu_option";
        break;

      case "menu_option":
        if (input === "📖 Ver menú") {
          reply = textMsg(
            "📖 *MENÚ*\n\n" +
            "🍕 Grande: $150\n" +
            "🍕 Extra grande: $190\n" +
            "🧀 Orilla de queso: +$40\n" +
            "➕ Extra ingrediente: $15\n" +
            "🚚 Envío: $40"
          );
          session.step = "menu";
        }

        else if (input === "🛒 Realizar pedido") {
          session.currentPizza = { extras: [] };
          session.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Tipos de pizza",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Hawaiana", title: "Hawaiana" },
                { id: "Mexicana", title: "Mexicana" },
                { id: "Carnes frías", title: "Carnes frías" }
              ]
            }
          ]);
        }

        else {
          reply = textMsg("👋 Gracias por visitarnos.");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        session.currentPizza.type = input;
        session.step = "size";
        reply = buttons("📏 Tamaño:", [
          "Grande (8 rebanadas)",
          "Extra grande (10 rebanadas)"
        ]);
        break;

      case "size":
        session.currentPizza.size = input;
        session.step = "crust";
        reply = buttons("🧀 ¿Agregar orilla de queso? (+$40)", ["Sí", "No"]);
        break;

      case "crust":
        session.currentPizza.crust = input === "Sí";
        session.step = "extras";
        reply = buttons("➕ Extras ($15 c/u)", [
          "Pepperoni", "Jamón", "Jalapeño",
          "Piña", "Chorizo", "Queso", "Tocino", "Ninguno"
        ]);
        break;

      case "extras":
        if (input !== "Ninguno") {
          session.currentPizza.extras.push(input);
          session.step = "more_extras";
          reply = buttons("¿Agregar otro extra?", ["Sí", "No"]);
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", ["Sí", "No"]);
        }
        break;

      case "more_extras":
        if (input === "Sí") {
          session.step = "extras";
          reply = buttons("➕ Extras ($15 c/u)", [
            "Pepperoni", "Jamón", "Jalapeño",
            "Piña", "Chorizo", "Queso", "Tocino", "Ninguno"
          ]);
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", ["Sí", "No"]);
        }
        break;

      case "another_pizza":
        if (input === "Sí") {
          session.currentPizza = { extras: [] };
          session.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Tipos de pizza",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Hawaiana", title: "Hawaiana" },
                { id: "Mexicana", title: "Mexicana" },
                { id: "Carnes frías", title: "Carnes frías" }
              ]
            }
          ]);
        } else {
          session.step = "address";
          reply = textMsg("📍 Escribe tu dirección completa:");
        }
        break;

      case "address":
        session.address = input;
        session.step = "phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "phone":
        session.phone = input;

        let total = 0;
        let summary = "🆕 *NUEVO PEDIDO 🍕*\n\n";

        session.pizzas.forEach((p, i) => {
          const sizePrice = p.size.includes("Extra")
            ? PRICES.extragrande
            : PRICES.grande;

          total += sizePrice;
          if (p.crust) total += PRICES.orilla;
          total += p.extras.length * PRICES.extra;

          summary += `🍕 *Pizza ${i + 1}*\n`;
          summary += `• ${p.type}\n• ${p.size}\n`;
          if (p.crust) summary += `• Orilla de queso\n`;
          if (p.extras.length)
            summary += `• Extras: ${p.extras.join(", ")}\n`;
          summary += "\n";
        });

        total += PRICES.envio;
        summary += `🚚 Envío: $40\n💰 *TOTAL:* $${total} MXN\n\n`;
        summary += `📍 ${session.address}\n📞 ${session.phone}`;

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

function list(text, sections) {
  return {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text },
      action: {
        button: "Seleccionar",
        sections
      }
    }
  };
}

async function sendMessage(to, payload) {
  await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
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

// ====================
// SERVER
// ====================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
