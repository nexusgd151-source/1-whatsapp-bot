const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

// ====================
// ENV
// ====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ====================
// SESIONES
// ====================
const sessions = {};

// ====================
// PRECIOS REALES
// ====================
const PRICES = {
  Pepperoni: { grande: 130, extragrande: 180 },
  "Carnes frías": { grande: 170, extragrande: 220 },
  Hawaiana: { grande: 150, extragrande: 210 },
  Mexicana: { grande: 200, extragrande: 250 },
  "Orilla de queso": { grande: 170, extragrande: 240 },
  extra: 15,
  envio: 40
};

// ====================
// TEST
// ====================
app.get("/", (_, res) => res.send("Bot activo 🚀"));

// ====================
// VERIFY
// ====================
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ====================
// WEBHOOK
// ====================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    let input = null;
    if (msg.type === "text") input = msg.text.body;
    if (msg.type === "interactive") {
      input =
        msg.interactive.button_reply?.title ||
        msg.interactive.list_reply?.id;
    }

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: []
      };
    }

    const s = sessions[from];
    let reply;

    switch (s.step) {
      case "menu":
        reply = buttons(
          "🍕 *Bienvenido a Pizzería Villa*\n¿Qué deseas hacer?",
          ["📖 Ver menú", "🛒 Realizar pedido", "❌ Cancelar"]
        );
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "📖 Ver menú") {
          reply = textMsg(
            "📖 *MENÚ*\n\n" +
            "🍕 Pepperoni G $130 | EG $180\n" +
            "🍕 Carnes frías G $170 | EG $220\n" +
            "🍕 Hawaiana G $150 | EG $210\n" +
            "🍕 Mexicana G $200 | EG $250\n" +
            "🧀 Orilla de queso G $170 | EG $240\n" +
            "➕ Extra $15\n🚚 Envío $40"
          );
          s.step = "menu";
        } else if (input === "🛒 Realizar pedido") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Pizzas",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Carnes frías", title: "Carnes frías" },
                { id: "Hawaiana", title: "Hawaiana" },
                { id: "Mexicana", title: "Mexicana" },
                { id: "Orilla de queso", title: "Orilla de queso" }
              ]
            }
          ]);
        } else {
          reply = textMsg("👋 Gracias por visitarnos");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        reply = buttons("📏 Tamaño", ["Grande", "Extra grande"]);
        break;

      case "size":
        s.currentPizza.size = input === "Grande" ? "grande" : "extragrande";
        s.step = "extras";
        reply = buttons("➕ Extras ($15)", [
          "Pepperoni", "Jamón", "Jalapeño", "Piña",
          "Chorizo", "Queso", "Tocino", "Ninguno"
        ]);
        break;

      case "extras":
        if (input !== "Ninguno") {
          s.currentPizza.extras.push(input);
          reply = buttons("¿Agregar otro extra?", ["Sí", "No"]);
          s.step = "more_extras";
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", ["Sí", "No"]);
        }
        break;

      case "more_extras":
        if (input === "Sí") {
          s.step = "extras";
          reply = buttons("➕ Extras ($15)", [
            "Pepperoni", "Jamón", "Jalapeño", "Piña",
            "Chorizo", "Queso", "Tocino", "Ninguno"
          ]);
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", ["Sí", "No"]);
        }
        break;

      case "another_pizza":
        if (input === "Sí") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Pizzas",
              rows: [
                { id: "Pepperoni", title: "Pepperoni" },
                { id: "Carnes frías", title: "Carnes frías" },
                { id: "Hawaiana", title: "Hawaiana" },
                { id: "Mexicana", title: "Mexicana" },
                { id: "Orilla de queso", title: "Orilla de queso" }
              ]
            }
          ]);
        } else {
          s.step = "delivery";
          reply = buttons("🚚 ¿Cómo deseas recibir tu pedido?", [
            "🏍️ A domicilio (+$40)",
            "🏪 Pasar a recoger"
          ]);
        }
        break;

      case "delivery":
        s.delivery = input.includes("domicilio");
        if (s.delivery) {
          s.step = "address";
          reply = textMsg("📍 Escribe tu dirección:");
        } else {
          s.step = "summary";
        }
        break;

      case "address":
        s.address = input;
        s.step = "phone";
        reply = textMsg("📞 Número de teléfono:");
        break;

      case "phone":
        s.phone = input;
        s.step = "summary";
        break;
    }

    if (s.step === "summary") {
      let total = 0;
      let text = "🆕 *PEDIDO 🍕*\n\n";

      s.pizzas.forEach((p, i) => {
        const base = PRICES[p.type][p.size];
        const extras = p.extras.length * PRICES.extra;
        total += base + extras;

        text += `🍕 Pizza ${i + 1}\n• ${p.type}\n• ${p.size}\n`;
        if (p.extras.length) text += `• Extras: ${p.extras.join(", ")}\n`;
        text += "\n";
      });

      if (s.delivery) {
        total += PRICES.envio;
        text += "🚚 Envío: $40\n";
        text += `📍 ${s.address}\n📞 ${s.phone}\n\n`;
      } else {
        text += "🏪 *Pasa a recoger*\n\n";
      }

      text += `💰 *TOTAL:* $${total} MXN`;
      reply = textMsg(text);
      delete sessions[from];
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ====================
// HELPERS
// ====================
const textMsg = body => ({ type: "text", text: { body } });

const buttons = (text, options) => ({
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
});

const list = (text, sections) => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text },
    action: { button: "Seleccionar", sections }
  }
});

async function sendMessage(to, payload) {
  await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload })
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Bot corriendo en puerto ${PORT}`)
);
