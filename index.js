const express = require("express");
const axios = require("axios");

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
// PRECIOS
// ====================
const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla: { grande: 170, extragrande: 240 },
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
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    let input = null;

    if (msg.type === "text") input = msg.text.body.trim().toLowerCase();
    if (msg.type === "interactive") {
      input =
        msg.interactive.button_reply?.id ||
        msg.interactive.list_reply?.id;
    }

    if (!sessions[from]) {
      sessions[from] = { step: "menu", pizzas: [] };
    }

    const s = sessions[from];
    let reply = null;

    switch (s.step) {
      case "menu":
        reply = buttons("🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?", [
          { id: "ver_menu", title: "📖 Ver menú" },
          { id: "pedido", title: "🛒 Realizar pedido" }
        ]);
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "ver_menu") {
          reply = textMsg(
            "📖 MENÚ\n\n" +
              "Pepperoni G $130 | EG $180\n" +
              "Carnes frías G $170 | EG $220\n" +
              "Hawaiana G $150 | EG $210\n" +
              "Mexicana G $200 | EG $250\n" +
              "Orilla de queso G $170 | EG $240\n" +
              "Extra $15\nEnvío $40"
          );
        } else if (input === "pedido") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = list("🍕 Elige tu pizza", [
            {
              title: "Pizzas",
              rows: [
                { id: "pepperoni", title: "Pepperoni" },
                { id: "carnes", title: "Carnes frías" },
                { id: "hawaiana", title: "Hawaiana" },
                { id: "mexicana", title: "Mexicana" },
                { id: "orilla", title: "Orilla de queso" }
              ]
            }
          ]);
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        reply = buttons("📏 Tamaño", [
          { id: "size_grande", title: "Grande" },
          { id: "size_extragrande", title: "Extra grande" }
        ]);
        break;

      case "size":
        s.currentPizza.size =
          input === "size_grande" ? "grande" : "extragrande";
        s.step = "extras";
        reply = buttons("➕ ¿Agregar extra?", [
          { id: "extra_si", title: "Sí" },
          { id: "extra_no", title: "No" }
        ]);
        break;

      case "extras":
        if (input === "extra_si") {
          s.currentPizza.extras.push("extra");
          s.pizzas.push(s.currentPizza);
        } else {
          s.pizzas.push(s.currentPizza);
        }
        s.step = "summary";
        break;
    }

    if (s.step === "summary") {
      let total = 0;
      let text = "🧾 PEDIDO\n\n";

      s.pizzas.forEach((p, i) => {
        const base = PRICES[p.type][p.size];
        const extras = p.extras.length * PRICES.extra;
        total += base + extras;
        text += `🍕 ${i + 1}. ${p.type} ${p.size}\n`;
      });

      text += `\n💰 TOTAL: $${total}`;
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
        reply: o
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
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to, ...payload },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(8080, () => console.log("🚀 Bot listo"));
