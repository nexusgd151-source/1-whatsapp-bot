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
// NORMALIZE
// ====================
const normalize = txt =>
  txt
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
        reply = buttons("🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?", [
          { id: "pedido", title: "🛒 Realizar pedido" },
          { id: "menu", title: "📖 Ver menú" }
        ]);
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "menu") {
          reply = textMsg(
            "📖 MENÚ\n\n" +
            "Pepperoni G $130 | EG $180\n" +
            "Carnes frías G $170 | EG $220\n" +
            "Hawaiana G $150 | EG $210\n" +
            "Mexicana G $200 | EG $250\n" +
            "Orilla de queso G $170 | EG $240\n" +
            "Extra $15\nEnvío $40"
          );
        } else {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
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
          ]);
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        reply = buttons("📏 Tamaño", [
          { id: "grande", title: "Grande" },
          { id: "extragrande", title: "Extra grande" }
        ]);
        break;

      case "size":
        s.currentPizza.size = input;
        s.step = "ask_extra";
        reply = buttons("➕ ¿Agregar extra?", [
          { id: "extra_si", title: "Sí" },
          { id: "extra_no", title: "No" }
        ]);
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = list("➕ Elige un extra ($15)", [
            {
              title: "Extras",
              rows: [
                { id: "pepperoni", title: "Pepperoni" },
                { id: "jamon", title: "Jamón" },
                { id: "jalapeno", title: "Jalapeño" },
                { id: "pina", title: "Piña" },
                { id: "chorizo", title: "Chorizo" },
                { id: "queso", title: "Queso extra" }
              ]
            }
          ]);
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("🍕 ¿Agregar otra pizza?", [
            { id: "si", title: "Sí" },
            { id: "no", title: "No" }
          ]);
        }
        break;

      case "choose_extra":
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = buttons("➕ ¿Agregar otro extra?", [
          { id: "extra_si", title: "Sí" },
          { id: "extra_no", title: "No" }
        ]);
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = list("➕ Elige otro extra ($15)", [
            {
              title: "Extras",
              rows: [
                { id: "pepperoni", title: "Pepperoni" },
                { id: "jamon", title: "Jamón" },
                { id: "jalapeno", title: "Jalapeño" },
                { id: "pina", title: "Piña" },
                { id: "chorizo", title: "Chorizo" },
                { id: "queso", title: "Queso extra" }
              ]
            }
          ]);
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("🍕 ¿Agregar otra pizza?", [
            { id: "si", title: "Sí" },
            { id: "no", title: "No" }
          ]);
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
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
          ]);
        } else {
          s.step = "summary";
        }
        break;
    }

    // ====================
    // SUMMARY
    // ====================
    if (s.step === "summary") {
      let total = 0;
      let text = "🧾 PEDIDO\n\n";

      s.pizzas.forEach((p, i) => {
        const base = PRICES[p.type][p.size];
        const extras = p.extras.length * PRICES.extra;
        total += base + extras;

        text += `🍕 ${i + 1}. ${p.type} ${p.size}\n`;
        if (p.extras.length)
          text += `   Extras: ${p.extras.join(", ")}\n`;
        text += "\n";
      });

      text += `💰 TOTAL: $${total}`;
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
        reply: { id: o.id, title: o.title }
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
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      ...payload
    })
  });
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () =>
  console.log("🚀 Bot corriendo")
);
