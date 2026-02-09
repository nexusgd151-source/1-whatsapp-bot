const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};

/* =====================
   CONFIG
===================== */

const normalize = txt =>
  txt?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla_queso: { grande: 170, extragrande: 240 },
  extra: 15,
  envio: 40
};

const PIZZAS = Object.keys(PRICES).filter(
  p => !["extra", "envio"].includes(p)
);

/* =====================
   VALIDACIONES
===================== */

const TEXT_ALLOWED_STEPS = [
  "ask_address",
  "ask_phone",
  "ask_pickup_name"
];

const STEP_OPTIONS = {
  menu_option: ["pedido", "menu"],
  pizza_type: PIZZAS,
  size: ["grande", "extragrande"],
  ask_extra: ["extra_si", "extra_no"],
  more_extras: ["extra_si", "extra_no"],
  another_pizza: ["si", "no"],
  delivery_method: ["domicilio", "recoger"]
};

const invalidMsg = step =>
  textMsg(
    `⚠️ Opción no válida.\n\n👉 Estás en el paso: *${step.replace("_", " ")}*\nUsa los botones mostrados.`
  );

/* =====================
   WEBHOOK
===================== */

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    const rawText = msg.type === "text" ? msg.text.body.trim() : null;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    if (input) input = normalize(input);

    if (!sessions[from]) {
      sessions[from] = { step: "menu", pizzas: [] };
    }

    const s = sessions[from];
    let reply;

    /* ❌ CANCELAR PEDIDO */
    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado. Escribe *Hola* para iniciar de nuevo."));
      return res.sendStatus(200);
    }

    /* 🚫 TEXTO NO PERMITIDO */
    if (rawText && !TEXT_ALLOWED_STEPS.includes(s.step)) {
      await sendMessage(from, invalidMsg(s.step));
      return res.sendStatus(200);
    }

    /* 🚫 BOTÓN INVÁLIDO */
    if (input && STEP_OPTIONS[s.step] && !STEP_OPTIONS[s.step].includes(input)) {
      await sendMessage(from, invalidMsg(s.step));
      return res.sendStatus(200);
    }

    switch (s.step) {

      case "menu":
        reply = startMenu();
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "menu") {
          reply = textMsg(
            "📖 MENÚ\n\nPepperoni G $130 | EG $180\nCarnes frías G $170 | EG $220\nHawaiana G $150 | EG $210\nMexicana G $200 | EG $250\nOrilla de queso G $170 | EG $240\nExtra $15\nEnvío $40"
          );
          s.step = "menu";
        } else {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = pizzaList();
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        reply = sizeButtons();
        break;

      case "size":
        s.currentPizza.size = input;
        s.step = "ask_extra";
        reply = extraAsk();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = anotherPizza();
        }
        break;

      case "choose_extra":
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = moreExtras();
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          reply = anotherPizza();
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          reply = pizzaList();
        } else {
          s.step = "delivery_method";
          reply = deliveryButtons();
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = "Domicilio";
          s.step = "ask_address";
          reply = textMsg("📍 Escribe tu dirección completa:");
        } else {
          s.delivery = "Recoger";
          s.step = "ask_pickup_name";
          reply = textMsg("🙋 Nombre de quien recogerá la pizza:");
        }
        break;

      case "ask_address":
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "ask_phone":
        s.phone = rawText;
        reply = summary(s);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        s.pickupName = rawText;
        reply = summary(s);
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

/* =====================
   MENSAJES
===================== */

const startMenu = () => buttons(
  "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?",
  [
    { id: "pedido", title: "🛒 Realizar pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar pedido" }
  ]
);

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: PIZZAS.map(p => ({ id: p, title: p.replace("_", " ") }))
}]);

const sizeButtons = () => buttons("📏 Tamaño", [
  { id: "grande", title: "Grande" },
  { id: "extragrande", title: "Extra grande" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const extraAsk = () => buttons("➕ ¿Agregar extra?", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const extraList = () => list("➕ Elige un extra", [{
  title: "Extras",
  rows: ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"]
    .map(e => ({ id: e, title: e }))
}]);

const moreExtras = () => buttons("➕ ¿Agregar otro extra?", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const deliveryButtons = () => buttons("🚚 ¿Cómo deseas tu pedido?", [
  { id: "domicilio", title: "A domicilio" },
  { id: "recoger", title: "Recoger en tienda" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const summary = s => {
  let total = 0;
  let text = "🧾 PEDIDO CONFIRMADO\n\n";

  s.pizzas.forEach((p, i) => {
    total += PRICES[p.type][p.size] + p.extras.length * PRICES.extra;
    text += `🍕 ${i + 1}. ${p.type} ${p.size}\n`;
    if (p.extras.length) text += `   Extras: ${p.extras.join(", ")}\n`;
    text += "\n";
  });

  if (s.delivery === "Domicilio") {
    total += PRICES.envio;
    text += `🚚 Envío: $40\n📍 ${s.address}\n📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 Recoge: ${s.pickupName}\n\n`;
  }

  text += `💰 TOTAL: $${total}\n\n✅ ¡Gracias por tu pedido!`;
  return textMsg(text);
};

/* =====================
   HELPERS
===================== */

const textMsg = body => ({ type: "text", text: { body } });

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
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload })
  });
}

app.listen(process.env.PORT || 8080, () =>
  console.log("🤖 Bot anti-tontos activo")
);
