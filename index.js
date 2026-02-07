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
// SESIONES (en memoria)
// ====================
const sessions = {};

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
// PRECIOS (IDS LIMPIOS)
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

    if (typeof input === "string") {
      input = normalize(input);
    }

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: []
      };
    }

    const s = sessions[from];
    let reply = null;

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
        } 
        else if (input === "pedido") {
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
          reply = textMsg("👋 Pedido cancelado. ¡Vuelve pronto!");
          delete sessions[from];
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = textMsg("❌ Pizza inválida, intenta otra.");
          break;
        }
        s.currentPizza.type = input;
        s.step = "size";
        reply = buttons("📏 Tamaño", [
          { id: "grande", title: "Grande" },
          { id: "extragrande", title: "Extra grande" }
        ]);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = textMsg("❌ Tamaño inválido.");
          break;
        }
        s.currentPizza.size = input;
        s.step = "extras";
        reply = buttons("➕ Extras ($15)", [
          { id: "pepperoni", title: "Pepperoni" },
          { id: "jamon", title: "Jamón" },
          { id: "jalapeno", title: "Jalapeño" },
          { id: "pina", title: "Piña" },
          { id: "chorizo", title: "Chorizo" },
          { id: "queso", title: "Queso" },
          { id: "tocino", title: "Tocino" },
          { id: "ninguno", title: "Ninguno" }
        ]);
        break;

      case "extras":
        if (input !== "ninguno") {
          s.currentPizza.extras.push(input);
          s.step = "more_extras";
          reply = buttons("¿Agregar otro extra?", [
            { id: "si", title: "Sí" },
            { id: "no", title: "No" }
          ]);
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", [
            { id: "si", title: "Sí" },
            { id: "no", title: "No" }
          ]);
        }
        break;

      case "more_extras":
        if (input === "si") {
          s.step = "extras";
          reply = buttons("➕ Extras ($15)", [
            { id: "pepperoni", title: "Pepperoni" },
            { id: "jamon", title: "Jamón" },
            { id: "jalapeno", title: "Jalapeño" },
            { id: "pina", title: "Piña" },
            { id: "chorizo", title: "Chorizo" },
            { id: "queso", title: "Queso" },
            { id: "tocino", title: "Tocino" },
            { id: "ninguno", title: "Ninguno" }
          ]);
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = buttons("¿Agregar otra pizza?", [
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
          s.step = "delivery";
          reply = buttons("🚚 ¿Cómo deseas recibir tu pedido?", [
            { id: "domicilio", title: "🏍️ A domicilio (+$40)" },
            { id: "recoger", title: "🏪 Pasar a recoger" }
          ]);
        }
        break;

      case "delivery":
        s.delivery = input === "domicilio";
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
        text += "🏪 *Pasa a recoger*\n\n";
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
        reply: {
          id: o.id,
          title: o.title
        }
      }))
    }
  }
});

const list = (text, sections) => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text },
    action: {
      button: "Seleccionar",
      sections
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
