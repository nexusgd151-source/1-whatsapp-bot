const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/* ======================
   SESIONES
====================== */
const sessions = {};

/* ======================
   UTILS
====================== */
const normalize = txt =>
  txt?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

/* ======================
   PRECIOS
====================== */
const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla_queso: { grande: 170, extragrande: 240 },
  extra: 15,
  envio: 40
};

/* ======================
   PASOS QUE ACEPTAN TEXTO
====================== */
const TEXT_ALLOWED = ["ask_address", "ask_phone", "ask_pickup_name"];

/* ======================
   MENSAJE ERROR + REENVÍO
====================== */
const invalid = (step) => textMsg(
  `⚠️ Opción no válida.\n👉 Estás en el paso: *${step}*\nUsa los botones mostrados.`
);

/* ======================
   WEBHOOK
====================== */
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    const rawText = msg.text?.body;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    if (input) input = normalize(input);

    /* ===== Cancelar SIEMPRE ===== */
    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, startMenu());
      return res.sendStatus(200);
    }

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: [],
        currentPizza: null
      };
    }

    const s = sessions[from];
    let reply;

    /* ===== TEXTO DONDE NO DEBE ===== */
    if (rawText && !TEXT_ALLOWED.includes(s.step)) {
      reply = invalid(s.step);
      reply = merge(reply, stepUI(s));
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    switch (s.step) {

      case "menu":
        s.step = "menu_option";
        reply = startMenu();
        break;

      case "menu_option":
        if (input === "menu") {
          reply = merge(
            textMsg(
              "📖 MENÚ\n\nPepperoni G $130 | EG $180\nCarnes frías G $170 | EG $220\nHawaiana G $150 | EG $210\nMexicana G $200 | EG $250\nOrilla de queso G $170 | EG $240\nExtra $15\nEnvío $40"
            ),
            startMenu()
          );
        } else if (input === "pedido") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = stepUI(s);
        } else {
          reply = merge(invalid(s.step), stepUI(s));
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = merge(invalid(s.step), stepUI(s));
          break;
        }
        s.currentPizza.type = input;
        s.step = "size";
        reply = stepUI(s);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = merge(invalid(s.step), stepUI(s));
          break;
        }
        s.currentPizza.size = input;
        s.step = "ask_extra";
        reply = stepUI(s);
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = stepUI(s);
        } else if (input === "extra_no") {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = stepUI(s);
        } else {
          reply = merge(invalid(s.step), stepUI(s));
        }
        break;

      case "choose_extra":
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = stepUI(s);
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = stepUI(s);
        } else if (input === "extra_no") {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = stepUI(s);
        } else {
          reply = merge(invalid(s.step), stepUI(s));
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = stepUI(s);
        } else if (input === "no") {
          s.step = "delivery_method";
          reply = stepUI(s);
        } else {
          reply = merge(invalid(s.step), stepUI(s));
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = "Domicilio";
          s.step = "ask_address";
          reply = stepUI(s);
        } else if (input === "recoger") {
          s.delivery = "Recoger";
          s.step = "ask_pickup_name";
          reply = stepUI(s);
        } else {
          reply = merge(invalid(s.step), stepUI(s));
        }
        break;

      case "ask_address":
        s.address = rawText;
        s.step = "ask_phone";
        reply = stepUI(s);
        break;

      case "ask_phone":
        s.phone = rawText;
        reply = buildSummary(s, true);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        s.pickupName = rawText;
        reply = buildSummary(s, false);
        delete sessions[from];
        break;
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

/* ======================
   UI POR PASO
====================== */
const stepUI = (s) => {
  switch (s.step) {
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons();
    case "ask_extra": return extraAsk();
    case "choose_extra": return extraList();
    case "more_extras": return extraMore();
    case "another_pizza": return anotherPizza();
    case "delivery_method": return deliveryButtons();
    case "ask_address": return textMsg("📍 Escribe tu dirección completa:");
    case "ask_phone": return textMsg("📞 Escribe tu número de teléfono:");
    case "ask_pickup_name": return textMsg("🙋 Nombre de quien recogerá:");
  }
};

/* ======================
   HELPERS UI
====================== */
const startMenu = () => buttons(
  "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?",
  [
    { id: "pedido", title: "🛒 Realizar pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const sizeButtons = () => buttons("📏 Tamaño", [
  { id: "grande", title: "Grande" },
  { id: "extragrande", title: "Extra grande" }
]);

const extraAsk = () => buttons("➕ ¿Agregar extra?", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" }
]);

const extraMore = () => extraAsk();

const deliveryButtons = () => buttons("🚚 ¿Cómo deseas tu pedido?", [
  { id: "domicilio", title: "A domicilio" },
  { id: "recoger", title: "Recoger en tienda" }
]);

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: Object.keys(PRICES)
    .filter(p => !["extra", "envio"].includes(p))
    .map(p => ({ id: p, title: p.replace("_", " ") }))
}]);

const extraList = () => list("➕ Extras ($15)", [{
  title: "Extras",
  rows: ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"]
    .map(e => ({ id: e, title: e }))
}]);

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" }
]);

/* ======================
   MENSAJES
====================== */
const textMsg = body => ({ type: "text", text: { body } });

const merge = (a, b) => [a, b];

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

/* ======================
   RESUMEN
====================== */
const buildSummary = (s, delivery) => {
  let total = 0;
  let text = "🧾 PEDIDO CONFIRMADO\n\n";

  s.pizzas.forEach((p, i) => {
    total += PRICES[p.type][p.size] + p.extras.length * PRICES.extra;
    text += `🍕 ${i + 1}. ${p.type} ${p.size}\n`;
    if (p.extras.length) text += `   Extras: ${p.extras.join(", ")}\n`;
    text += "\n";
  });

  if (delivery) {
    total += PRICES.envio;
    text += `🚚 Envío: $40\n📍 ${s.address}\n📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 Recoge: ${s.pickupName}\n\n`;
  }

  text += `💰 TOTAL: $${total}\n\n✅ ¡Gracias por tu pedido!`;
  return textMsg(text);
};

/* ======================
   ENVÍO
====================== */
async function sendMessage(to, payload) {
  const msgs = Array.isArray(payload) ? payload : [payload];
  for (const m of msgs) {
    await fetch(`https://graph.facebook.com/v24.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...m })
    });
  }
}

app.listen(process.env.PORT || 8080, () =>
  console.log("🚀 Bot blindado y listo")
);
