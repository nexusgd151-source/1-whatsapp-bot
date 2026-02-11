const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ================= CONFIG =================
const SESSION_TIMEOUT = 5 * 60 * 1000;

const PRICES = {
  pepperoni: { grande: 130, extragrande: 180 },
  carnes_frias: { grande: 170, extragrande: 220 },
  hawaiana: { grande: 150, extragrande: 210 },
  mexicana: { grande: 200, extragrande: 250 },
  orillaQueso: 40,
  extra: 15,
  envio: 40
};

const sessions = {};

// ================= UTILS =================
const normalize = t =>
  t?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const now = () => Date.now();

const resetSession = (from) => {
  sessions[from] = {
    step: "menu",
    pizzas: [],
    last: now(),
    expected: []
  };
};

const expired = s => now() - s.last > SESSION_TIMEOUT;

const textAllowed = step =>
  ["ask_address", "ask_phone", "ask_pickup_name"].includes(step);

// ================= WEBHOOK =================
app.post("/webhook", async (req, res) => {
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  if (!value?.messages) return res.sendStatus(200);

  const msg = value.messages[0];
  const from = msg.from;

  let input =
    msg.interactive?.button_reply?.id ||
    msg.interactive?.list_reply?.id;

  input = normalize(input);
  const rawText = msg.type === "text" ? msg.text.body : null;

  if (!sessions[from] || expired(sessions[from])) {
    resetSession(from);
    await sendMessage(from, mainMenu());
    return res.sendStatus(200);
  }

  const s = sessions[from];
  s.last = now();

  // CANCELAR
  if (input === "cancelar") {
    resetSession(from);
    await sendMessage(from, textMsg("❌ Pedido cancelado."));
    await sendMessage(from, mainMenu());
    return res.sendStatus(200);
  }

  // VALIDACIÓN
  if (s.expected.length && !s.expected.includes(input) && !textAllowed(s.step)) {
    await sendMessage(from, errorMsg(s.step));
    await sendMessage(from, resend(s));
    return res.sendStatus(200);
  }

  let reply;

  switch (s.step) {

    case "menu":
      s.step = "menu_option";
      s.expected = ["pedido", "menu"];
      reply = mainMenu();
      break;

    case "menu_option":
      if (input === "menu") {
        reply = menuText();
        s.step = "menu";
      } else {
        s.currentPizza = { extras: [], orillaQueso: false };
        s.step = "pizza_type";
        s.expected = Object.keys(PRICES).filter(p => typeof PRICES[p] === "object");
        reply = pizzaList();
      }
      break;

    case "pizza_type":
      s.currentPizza.type = input;
      s.step = "size";
      s.expected = ["grande", "extragrande"];
      reply = sizeButtons(input);
      break;

    case "size":
      s.currentPizza.size = input;
      s.step = "orilla_queso";
      s.expected = ["si", "no"];
      reply = orillaQuesoButtons();
      break;

    case "orilla_queso":
      s.currentPizza.orillaQueso = input === "si";
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
        s.currentPizza = { extras: [], orillaQueso: false };
        s.step = "pizza_type";
        s.expected = Object.keys(PRICES).filter(p => typeof PRICES[p] === "object");
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
        reply = textMsg("📍 Escribe tu dirección completa:");
      } else {
        s.delivery = "Recoger";
        s.step = "ask_pickup_name";
        reply = textMsg("🙋 Nombre de quien recoge:");
      }
      s.expected = [];
      break;

    case "ask_address":
      s.address = rawText;
      s.step = "ask_phone";
      reply = textMsg("📞 Escribe tu teléfono:");
      break;

    case "ask_phone":
      s.phone = rawText;
      reply = buildSummary(s);
      delete sessions[from];
      break;

    case "ask_pickup_name":
      s.pickupName = rawText;
      reply = buildSummary(s);
      delete sessions[from];
      break;
  }

  if (reply) await sendMessage(from, reply);
  res.sendStatus(200);
});

// ================= UI =================
const mainMenu = () => buttons("🍕 Bienvenido a Pizzería Villa", [
  { id: "pedido", title: "🛒 Realizar pedido" },
  { id: "menu", title: "📖 Ver menú" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: Object.entries(PRICES)
    .filter(([k,v]) => typeof v === "object")
    .map(([k,v]) => ({
      id: k,
      title: `${k.replace("_"," ")} G $${v.grande} | EG $${v.extragrande}`
    }))
}]);

const sizeButtons = (pizza) => buttons(`📏 Tamaño (${pizza})`, [
  { id: "grande", title: `Grande $${PRICES[pizza].grande}` },
  { id: "extragrande", title: `Extra grande $${PRICES[pizza].extragrande}` },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const orillaQuesoButtons = () => buttons(
  "🧀 ¿Orilla de queso? (+$40)",
  [
    { id: "si", title: "Sí (+$40)" },
    { id: "no", title: "No" },
    { id: "cancelar", title: "❌ Cancelar pedido" }
  ]
);

const askExtra = () => buttons("➕ ¿Agregar extras? ($15 c/u)", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const askMoreExtras = askExtra;

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar pedido" }
]);

const deliveryButtons = () => buttons("🚚 ¿Cómo deseas tu pedido?", [
  { id: "domicilio", title: "A domicilio (+$40)" },
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
  textMsg("📖 MENÚ\nPepperoni $130\nHawaiana $150\nMexicana $200\nOrilla de queso +$40\nExtra +$15\nEnvío $40");

const errorMsg = step =>
  textMsg(`⚠️ Opción no válida.\n👉 Estás en el paso: *${step}*`);

const resend = s => ({
  menu: mainMenu,
  pizza_type: pizzaList,
  size: () => sizeButtons(s.currentPizza.type),
  orilla_queso: orillaQuesoButtons,
  ask_extra: askExtra,
  choose_extra: extraList,
  more_extras: askMoreExtras,
  another_pizza: anotherPizza,
  delivery_method: deliveryButtons
}[s.step]?.() || mainMenu());

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

const buildSummary = (s) => {
  let total = 0;
  let text = "🧾 PEDIDO CONFIRMADO\n\n";

  s.pizzas.forEach((p,i) => {
    let price = PRICES[p.type][p.size];
    if (p.orillaQueso) price += PRICES.orillaQueso;
    price += p.extras.length * PRICES.extra;
    total += price;

    text += `🍕 ${i+1}. ${p.type} ${p.size}\n`;
    if (p.orillaQueso) text += `   🧀 Orilla de queso +$40\n`;
    if (p.extras.length) text += `   Extras: ${p.extras.join(", ")}\n`;
    text += `   Subtotal: $${price}\n\n`;
  });

  if (s.delivery === "Domicilio") {
    total += PRICES.envio;
    text += `🚚 Envío +$40\n📍 ${s.address}\n📞 ${s.phone}\n\n`;
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
