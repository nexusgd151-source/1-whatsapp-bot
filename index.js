const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// CONFIG
// =======================
const SESSION_TIMEOUT = 5 * 60 * 1000;

const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orilla_queso: 40,
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

const resetSession = from => {
  sessions[from] = {
    step: "menu",
    pizzas: [],
    lastAction: now(),
    expected: []
  };
};

const expired = s => now() - s.lastAction > SESSION_TIMEOUT;

const rawAllowed = step =>
  ["ask_address", "ask_phone", "ask_pickup_name"].includes(step);

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

    // ===== SESIÓN =====
    if (!sessions[from] || expired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // ===== CANCELAR =====
    if (input === "cancelar") {
      resetSession(from);
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    // ===== VALIDACIÓN ANTI-TONTOS =====
    if (s.expected.length && !s.expected.includes(input) && !rawAllowed(s.step)) {
      await sendMessage(from, errorMsg(s.step));
      await sendMessage(from, resendStep(s));
      return res.sendStatus(200);
    }

    let reply;

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
          s.currentPizza = { extras: [], orilla: false };
          s.expected = pizzaKeys();
          s.step = "pizza_type";
          reply = pizzaList();
        }
        break;

      case "pizza_type":
        s.currentPizza.type = input;
        s.expected = ["grande", "extragrande"];
        s.step = "size";
        reply = sizeButtons();
        break;

      case "size":
        s.currentPizza.size = input;
        s.expected = ["orilla_si", "orilla_no"];
        s.step = "orilla";
        reply = orillaButtons();
        break;

      case "orilla":
        s.currentPizza.orilla = input === "orilla_si";
        s.expected = ["extra_si", "extra_no"];
        s.step = "ask_extra";
        reply = askExtra();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.expected = extrasAllowed();
          s.step = "choose_extra";
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.expected = ["si", "no"];
          s.step = "another_pizza";
          reply = anotherPizza();
        }
        break;

      case "choose_extra":
        if (!s.currentPizza.extras.includes(input)) {
          s.currentPizza.extras.push(input);
        }
        s.expected = ["extra_si", "extra_no"];
        s.step = "more_extras";
        reply = askExtra();
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.expected = extrasAllowed();
          s.step = "choose_extra";
          reply = extraList();
        } else {
          s.pizzas.push(s.currentPizza);
          s.expected = ["si", "no"];
          s.step = "another_pizza";
          reply = anotherPizza();
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [], orilla: false };
          s.expected = pizzaKeys();
          s.step = "pizza_type";
          reply = pizzaList();
        } else {
          s.expected = ["domicilio", "recoger"];
          s.step = "delivery";
          reply = deliveryButtons();
        }
        break;

      case "delivery":
        if (input === "domicilio") {
          s.step = "ask_address";
          s.expected = [];
          reply = textMsg("📍 Escribe tu dirección:");
        } else {
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
// UI
// =======================
const mainMenu = () => buttons("🍕 Bienvenido a Pizzería Villa", [
  { id: "pedido", title: "🛒 Realizar pedido" },
  { id: "menu", title: "📖 Ver menú" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const pizzaKeys = () =>
  Object.keys(PRICES).filter(p => typeof PRICES[p] === "object");

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: pizzaKeys().map(p => ({
    id: p,
    title: `${p.replace("_"," ")} ($${PRICES[p].grande} / $${PRICES[p].extragrande})`
  }))
}]);

const sizeButtons = () => buttons("📏 Tamaño", [
  { id: "grande", title: "Grande" },
  { id: "extragrande", title: "Extra grande" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const orillaButtons = () => buttons("🧀 ¿Agregar orilla de queso? ($40)", [
  { id: "orilla_si", title: "Sí" },
  { id: "orilla_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const askExtra = () => buttons("➕ ¿Agregar extra? ($15)", [
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

const extrasAllowed = () =>
  ["pepperoni","jamon","jalapeno","pina","chorizo","queso"];

const extraList = () => list("➕ Elige un extra ($15)", [{
  title: "Extras",
  rows: extrasAllowed().map(e => ({ id: e, title: e }))
}]);

const menuText = () =>
  textMsg("📖 MENÚ\nPepperoni $130\nHawaiana $150\nMexicana $200\nOrilla queso $40\nExtra $15\nEnvío $40");

const errorMsg = step =>
  textMsg(`⚠️ Opción no válida.\n👉 Estás en el paso: ${step}\nUsa los botones.`);

const resendStep = s => ({
  menu: mainMenu(),
  pizza_type: pizzaList(),
  size: sizeButtons(),
  orilla: orillaButtons(),
  ask_extra: askExtra(),
  choose_extra: extraList(),
  another_pizza: anotherPizza(),
  delivery: deliveryButtons()
}[s.step] || mainMenu());

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

// =======================
// RESUMEN
// =======================
const buildSummary = (s, delivery) => {
  let total = 0;
  let text = "🧾 PEDIDO CONFIRMADO\n\n";

  s.pizzas.forEach((p,i) => {
    let price = PRICES[p.type][p.size];
    if (p.orilla) price += PRICES.orilla_queso;
    price += p.extras.length * PRICES.extra;
    total += price;

    text += `🍕 ${i+1}. ${p.type} ${p.size}\n`;
    if (p.orilla) text += "   🧀 Orilla de queso\n";
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

// =======================
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
