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
const processedMessages = new Set(); // 🔒 anti duplicados

// ====================
// NORMALIZADOR
// ====================
const normalize = text =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

// ====================
// PRECIOS
// ====================
const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla_queso: { grande: 170, extragrande: 240 },
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
    const messageId = msg.id;

    // 🔒 Anti duplicados
    if (processedMessages.has(messageId)) {
      return res.sendStatus(200);
    }
    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 5 * 60 * 1000);

    let input = null;

    if (msg.type === "text") input = msg.text.body;
    if (msg.type === "interactive") {
      input =
        msg.interactive.button_reply?.id ||
        msg.interactive.list_reply?.id;
    }

    if (typeof input === "string") input = normalize(input);

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: []
      };
    }

    const s = sessions[from];
    let reply = null;

    // ====================
    // FLOW
    // ====================
    switch (s.step) {

      case "menu":
        reply = buttons(
          "🍕 *Bienvenido a Pizzería Villa*\n¿Qué deseas hacer?",
          [
            { id: "ver_menu", title: "📖 Ver menú" },
            { id: "pedido", title: "🛒 Realizar pedido" },
            { id: "cancelar", title: "❌ Cancelar" }
          ]
        );
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "ver_menu") {
          reply = textMsg(
            "📖 *MENÚ*\n\n" +
            "🍕 Pepperoni G $130 | EG $180\n" +
            "🍕 Carnes frías G $170 | EG $220\n" +
            "🍕 Hawaiana G $150 | EG $210\n" +
            "🍕 Mexicana G $200 | EG $250\n" +
            "🧀 Orilla de queso G $170 | EG $240\n" +
            "➕ Extra $15\n🚚 Envío $40"
          );
        } else if (input === "pedido") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = pizzaList();
        } else {
          reply = textMsg("👋 Pedido cancelado");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = textMsg("❌ Elige una pizza válida");
          break;
        }
        s.currentPizza.type = input;
        s.step = "size";
        reply = sizeButtons();
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = textMsg("👇 Usa los botones");
          break;
        }
        s.currentPizza.size = input;
        s.step = "extras";
        reply = extrasButtons();
        break;

      case "extras":
        if (input === "ninguno") {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = yesNoButtons("¿Agregar otra pizza?");
        } else {
          s.currentPizza.extras.push(input);
          s.step = "more_extras";
          reply = yesNoButtons("¿Agregar otro extra?");
        }
        break;

      case "more_extras":
        if (["si", "sí"].includes(input)) {
          s.step = "extras";
          reply = extrasButtons();
        } else if (input === "no") {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = yesNoButtons("¿Agregar otra pizza?");
        } else {
          reply = textMsg("👇 Usa los botones");
        }
        break;

      case "another_pizza":
        if (["si", "sí"].includes(input)) {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          s.step = "delivery";
          reply = buttons("🚚 Entrega", [
            { id: "domicilio", title: "🏍️ A domicilio (+$40)" },
            { id: "recoger", title: "🏪 Recoger" }
          ]);
        } else {
          reply = textMsg("👇 Usa los botones");
        }
        break;

      case "delivery":
        s.delivery = input === "domicilio";
        if (s.delivery) {
          s.step = "address";
          reply = textMsg("📍 Dirección:");
        } else {
          s.step = "summary";
        }
        break;

      case "address":
        s.address = input;
        s.step = "phone";
        reply = textMsg("📞 Teléfono:");
        break;

      case "phone":
        s.phone = input;
        s.step = "summary";
        break;
    }

    // ====================
    // SUMMARY
    // ====================
    if (s.step === "summary") {
      let total = 0;
      let text = "🧾 *PEDIDO FINAL*\n\n";

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
        text += `🚚 Envío: $40\n📍 ${s.address}\n📞 ${s.phone}\n\n`;
      } else {
        text += "🏪 *Recoger en tienda*\n\n";
      }

      text += `💰 *TOTAL:* $${total} MXN`;
      reply = textMsg(text);
      delete sessions[from];
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
const textMsg = body => ({
  type: "text",
  text: { body }
});

const buttons = (text, options) => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text },
    action: {
      buttons: options.map(o => ({
        type: "reply",
        reply: o
      }))
    }
  }
});

const yesNoButtons = text =>
  buttons(text, [
    { id: "si", title: "Sí" },
    { id: "no", title: "No" }
  ]);

const sizeButtons = () =>
  buttons("📏 Tamaño", [
    { id: "grande", title: "Grande" },
    { id: "extragrande", title: "Extra grande" }
  ]);

const extrasButtons = () =>
  buttons("➕ Extras ($15)", [
    { id: "pepperoni", title: "Pepperoni" },
    { id: "jamon", title: "Jamón" },
    { id: "jalapeno", title: "Jalapeño" },
    { id: "pina", title: "Piña" },
    { id: "chorizo", title: "Chorizo" },
    { id: "queso", title: "Queso" },
    { id: "tocino", title: "Tocino" },
    { id: "ninguno", title: "Ninguno" }
  ]);

const pizzaList = () => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text: "🍕 Elige tu pizza" },
    action: {
      button: "Seleccionar",
      sections: [
        {
          title: "Pizzas",
          rows: [
            { id: "pepperoni", title: "Pepperoni" },
            { id: "carnes_frias", title: "Carnes frías" },
            { id: "hawaiana", title: "Hawaiana" },
            { id: "mexicana", title: "Mexicana" },
            { id: "orilla_queso", title: "Orilla de queso" }
          ]
        }
      ]
    }
  }
});

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Bot corriendo en puerto ${PORT}`)
);
