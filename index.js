const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

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
// TEST
// ====================
app.get("/", (_, res) => res.send("Bot activo 🚀"));

// ====================
// VERIFY WEBHOOK
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
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];
    const from = message.from;
    const type = message.type;

    let input = null;

    if (type === "text") input = message.text.body;
    if (type === "interactive") {
      if (message.interactive.button_reply)
        input = message.interactive.button_reply.title;
      if (message.interactive.list_reply)
        input = message.interactive.list_reply.title;
    }

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
          "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas?",
          ["📖 Menú", "🛒 Pedido", "❌ Cancelar"]
        );
        session.step = "menu_option";
        break;

      case "menu_option":
        if (input === "🛒 Pedido") {
          session.currentPizza = { extras: [] };
          session.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Pizzas",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Hawaiana", title: "Hawaiana" },
                { id: "Mexicana", title: "Mexicana" },
                { id: "Carnes", title: "Carnes frías" }
              ]
            }
          ]);
        } else {
          reply = textMsg("👋 Gracias por visitarnos");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        session.currentPizza.type = input;
        session.step = "size";
        reply = buttons("📏 Tamaño", ["Grande", "Extra grande"]);
        break;

      case "size":
        session.currentPizza.size = input;
        session.step = "crust";
        reply = buttons("🧀 ¿Orilla de queso?", ["Sí", "No"]);
        break;

      case "crust":
        session.currentPizza.crust = input === "Sí";
        session.step = "extras";
        reply = list("➕ Extras ($15)", [
          {
            title: "Extras",
            rows: [
              { id: "Pepperoni", title: "Pepperoni" },
              { id: "Jamón", title: "Jamón" },
              { id: "Jalapeño", title: "Jalapeño" },
              { id: "Piña", title: "Piña" },
              { id: "Queso", title: "Queso" },
              { id: "Tocino", title: "Tocino" },
              { id: "Ninguno", title: "Ninguno" }
            ]
          }
        ]);
        break;

      case "extras":
        if (input !== "Ninguno") {
          session.currentPizza.extras.push(input);
          reply = buttons("¿Otro extra?", ["Sí", "No"]);
          session.step = "more_extras";
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "address";
          reply = textMsg("📍 Dirección completa:");
        }
        break;

      case "more_extras":
        if (input === "Sí") {
          session.step = "extras";
          reply = list("➕ Extras ($15)", [
            {
              title: "Extras",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Jamón", title: "Jamón" },
                { id: "Jalapeño", title: "Jalapeño" },
                { id: "Piña", title: "Piña" },
                { id: "Queso", title: "Queso" },
                { id: "Tocino", title: "Tocino" },
                { id: "Ninguno", title: "Ninguno" }
              ]
            }
          ]);
        } else {
          session.pizzas.push(session.currentPizza);
          session.step = "address";
          reply = textMsg("📍 Dirección completa:");
        }
        break;

      case "address":
        session.address = input;
        session.step = "phone";
        reply = textMsg("📞 Teléfono:");
        break;

      case "phone":
        session.phone = input;

        let total = PRICES.envio;
        let summary = "🆕 *PEDIDO*\n\n";

        session.pizzas.forEach((p, i) => {
          const sizePrice =
            p.size === "Extra grande" ? PRICES.extragrande : PRICES.grande;
          total += sizePrice;
          if (p.crust) total += PRICES.orilla;
          total += p.extras.length * PRICES.extra;

          summary += `🍕 Pizza ${i + 1}\n• ${p.type}\n• ${p.size}\n`;
          if (p.crust) summary += "• Orilla\n";
          if (p.extras.length)
            summary += `• Extras: ${p.extras.join(", ")}\n`;
          summary += "\n";
        });

        summary += `🚚 Envío: $40\n💰 TOTAL: $${total}\n\n📍 ${session.address}\n📞 ${session.phone}`;
        reply = textMsg(summary);
        delete sessions[from];
        break;
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (err) {
    console.error(err);
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

// ====================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
});
