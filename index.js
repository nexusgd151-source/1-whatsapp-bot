const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// CONFIG
// =======================
const SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutos

const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla_queso: { grande: 170, extragrande: 240 },
  extra: 15,
  envio: 40
};

const sessions = {};

// =======================
// UTILS
// =======================
const normalize = t =>
  t?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const now = () => Date.now();

const resetSession = (from) => {
  sessions[from] = {
    step: "menu",
    pizzas: [],
    lastAction: now(),
    expected: []
  };
};

const isExpired = (s) => now() - s.lastAction > SESSION_TIMEOUT;

// =======================
// WEBHOOK
// =======================
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    const rawText = msg.type === "text" ? msg.text.body : null;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    input = normalize(input);

    // =======================
    // SESSION
    // =======================
    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // =======================
    // CANCELAR
    // =======================
    if (input === "cancelar") {
      resetSession(from);
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    // =======================
    // VALIDACIÓN
    // =======================
    if (s.expected.length && !s.expected.includes(input) && !rawTextAllowed(s.step)) {
      await sendMessage(from, errorMsg(s.step));
      await sendMessage(from, resendStep(s));
      return res.sendStatus(200);
    }

    let reply;

    // =======================
    // FLOW
    // =======================
    switch (s.step) {

      case "menu":
        s.expected = ["pedido", "menu"];
        reply = mainMenu();
        s.step = "menu_option";
        break;

      case "menu_option":
        if (input === "menu") {
          reply = menuText();
          s.step = "menu";
        } else {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          s.expected = Object.keys(PRICES).filter(p => !["extra","envio"].includes(p));
          reply = pizzaList();
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.step = "size";
        s.expected = ["grande", "extragrande"];
        reply = sizeButtons();
        break;

      case "size":
        s.currentPizza.size = input;
        s.step = "ask_extra";
        s.expected = ["extra_si", "extra_no"];
        reply = askExtra();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          s.expected = extrasAllowed();
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          s.expected = ["si", "no"];
          reply = anotherPizza();
        }
        break;

      case "choose_extra":
        if (!s.currentPizza.extras.includes(input)) {
          s.currentPizza.extras.push(input);
        }
        s.step = "more_extras";
        s.expected = ["extra_si", "extra_no"];
        reply = askMoreExtras();
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          s.expected = extrasAllowed();
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.step = "another_pizza";
          s.expected = ["si", "no"];
          reply = anotherPizza();
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [] };
          s.step = "pizza_type";
          s.expected = Object.keys(PRICES).filter(p => !["extra","envio"].includes(p));
          reply = pizzaList();
        } else {
          s.step = "delivery_method";
          s.expected = ["domicilio", "recoger"];
          reply = deliveryButtons();
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = "Domicilio";
          s.step = "ask_address";
          s.expected = [];
          reply = textMsg("📍 Escribe tu dirección completa:");
        } else {
          s.delivery = "Recoger";
          s.step = "ask_pickup_name";
          s.expected = [];
          reply = textMsg("🙋 Nombre de quien recoge:");
        }
        break;

      case "ask_address":
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu teléfono:");
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

// =======================
// HELPERS
// =======================
const rawTextAllowed = step =>
  ["ask_address", "ask_phone", "ask_pickup_name"].includes(step);

const errorMsg = step =>
  textMsg(`⚠️ Opción no válida.\n👉 Estás en el paso: *${step}*\nUsa los botones.`);

const resendStep = s => {
  switch (s.step) {
    case "MENU": return mainMenu();
    case "ELECCION DE PIZZA": return pizzaList();
    case "TAMAÑO": return sizeButtons();
    case "PREGUNTAR POR EXTRA": return askExtra();
    case "ESCOGER EXTRA": return extraList();
    case "OTRO EXTRA": return askMoreExtras();
    case "ESCOGER OTRA PIZZA": return anotherPizza();
    case "TIPO DE SERVICIO": return deliveryButtons();
    default: return mainMenu();
  }
};

// =======================
// UI
// =======================
const mainMenu = () => buttons("🍕 Bienvenido a Pizzería Villa", [
  { id: "pedido", title: "🛒 Realizar pedido" },
  { id: "menu", title: "📖 Ver menú" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: Object.keys(PRICES)
    .filter(p => !["extra","envio"].includes(p))
    .map(p => ({ id: p, title: p.replace("_"," ") }))
}] , true);

const sizeButtons = () => buttons("📏 Tamaño", [
  { id: "grande", title: "Grande" },
  { id: "extragrande", title: "Extra grande" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const askExtra = () => buttons("➕ ¿Agregar extra?", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const askMoreExtras = askExtra;

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const deliveryButtons = () => buttons("🚚 ¿Cómo deseas tu pedido?", [
  { id: "domicilio", title: "A domicilio" },
  { id: "recoger", title: "Recoger" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const extrasAllowed = () =>
  ["pepperoni","jamon","jalapeno","pina","chorizo","queso"];

const extraList = () => list("➕ Elige un extra ($15)", [{
  title: "Extras",
  rows: extrasAllowed().map(e => ({ id: e, title: e }))
}], true);

const menuText = () =>
  textMsg("📖 MENÚ\nPepperoni $130\nHawaiana $150\nMexicana $200\nExtra $15\nEnvío $40");

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

const buildSummary = (s, delivery) => {
  let total = 0;
  let text = "🧾 PEDIDO CONFIRMADO\n\n";

  s.pizzas.forEach((p,i) => {
    total += PRICES[p.type][p.size] + p.extras.length * PRICES.extra;
    text += `🍕 ${i+1}. ${p.type} ${p.size}\n`;
    if (p.extras.length) text += `   Extras: ${p.extras.join(", ")}\n`;
    text += "\n";
  });

  if (delivery) {
    total += PRICES.envio;
    text += `🚚 Envío\n📍 ${s.address}\n📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 Recoge: ${s.pickupName}\n\n`;
  }

  text += `💰 TOTAL: $${total}\n\n✅ Gracias por tu pedido`;
  return textMsg(text);
};

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
  console.log("🚀 Bot corriendo")
);
