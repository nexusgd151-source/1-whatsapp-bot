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

const resetSession = (from) => {
  sessions[from] = {
    step: "pizza_type", // EMPIEZA DIRECTO EN PIZZA_TYPE
    pizzas: [],
    currentPizza: { extras: [], crust: false },
    lastAction: now(),
    lastInput: null
  };
};

const isExpired = (s) => now() - s.lastAction > SESSION_TIMEOUT;
const TEXT_ONLY_STEPS = ["ask_address", "ask_phone", "ask_pickup_name"];

// =======================
// WEBHOOK - GET
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// =======================
// WEBHOOK - POST
// =======================
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

    // ===== SESIÓN =====
    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, pizzaList());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // ===== ANTI-SPAM =====
    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    // ===== CANCELAR =====
    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, pizzaList());
      return res.sendStatus(200);
    }

    // ===== TEXTO NO PERMITIDO =====
    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, textMsg(`⚠️ No escribas aquí.\n👉 Estás en: *${s.step}*`));
      await sendMessage(from, stepUI(s));
      return res.sendStatus(200);
    }

    let reply = null;

    // =======================
    // FLUJO CON BOTONES INTERACTIVOS
    // =======================
    switch (s.step) {

      // 1. ELEGIR PIZZA
      case "pizza_type":
        if (!PRICES[input]) {
          reply = merge(textMsg("❌ Pizza no válida"), pizzaList());
          break;
        }
        s.currentPizza.type = input;
        s.currentPizza.extras = [];
        s.currentPizza.crust = false;
        s.step = "size";
        reply = sizeButtons(s.currentPizza.type);
        break;

      // 2. ELEGIR TAMAÑO
      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = merge(textMsg("❌ Tamaño no válido"), sizeButtons(s.currentPizza.type));
          break;
        }
        s.currentPizza.size = input;
        s.step = "ask_cheese_crust";
        reply = askCrust();
        break;

      // 3. ORILLA DE QUESO
      case "ask_cheese_crust":
        if (input === "crust_si") {
          s.currentPizza.crust = true;
        } else if (input === "crust_no") {
          s.currentPizza.crust = false;
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askCrust());
          break;
        }
        s.step = "ask_extra";
        reply = askExtra();
        break;

      // 4. ¿AGREGAR EXTRA?
      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askExtra());
        }
        break;

      // 5. ELEGIR EXTRA
      case "choose_extra":
        if (!extrasAllowed().includes(input)) {
          reply = merge(textMsg("❌ Extra no válido"), extraList());
          break;
        }
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = askMoreExtras();
        break;

      // 6. ¿OTRO EXTRA?
      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askMoreExtras());
        }
        break;

      // 7. ¿OTRA PIZZA?
      case "another_pizza":
        if (input === "si") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          s.step = "delivery_method";
          reply = deliveryButtons();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), anotherPizza());
        }
        break;

      // 8. MÉTODO DE ENTREGA
      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = true;
          s.step = "ask_address";
          reply = textMsg("📍 Escribe tu dirección completa:");
        } else if (input === "recoger") {
          s.delivery = false;
          s.step = "ask_pickup_name";
          reply = textMsg("🙋 Nombre de quien recoge:");
        } else {
          reply = merge(textMsg("❌ Opción no válida"), deliveryButtons());
        }
        break;

      // 9. DIRECCIÓN
      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección inválida. Escribe una dirección válida:");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      // 10. TELÉFONO
      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg("⚠️ Teléfono inválido. Escribe un número válido:");
          break;
        }
        s.phone = rawText;
        reply = buildSummary(s);
        delete sessions[from];
        break;

      // 11. NOMBRE PARA RECOGER
      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido. Escribe un nombre válido:");
          break;
        }
        s.pickupName = rawText;
        reply = buildSummary(s);
        delete sessions[from];
        break;
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (e) {
    console.error("❌ Error:", e);
    res.sendStatus(500);
  }
});

// =======================
// UI - BOTONES INTERACTIVOS
// =======================

// 1. LISTA DE PIZZAS CON PRECIOS
const pizzaList = () => list("🍕 ELIGE TU PIZZA", [{
  title: "PIZZAS",
  rows: Object.keys(PRICES)
    .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
    .map(p => ({
      id: p,
      title: `${p.replace("_", " ")}`,
      description: `G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
    }))
}]);

// 2. BOTONES DE TAMAÑO CON PRECIOS
const sizeButtons = (pizzaType) => {
  const prices = PRICES[pizzaType];
  return buttons("📏 TAMAÑO", [
    { id: "grande", title: `Grande $${prices.grande}` },
    { id: "extragrande", title: `Extra grande $${prices.extragrande}` },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

// 3. ORILLA DE QUESO
const askCrust = () => buttons("🧀 ¿ORILLA DE QUESO? (+$40)", [
  { id: "crust_si", title: "Sí (+$40)" },
  { id: "crust_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

// 4. PREGUNTA EXTRAS
const askExtra = () => buttons("➕ ¿AGREGAR EXTRA? ($15 c/u)", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

// 5. LISTA DE EXTRAS
const extrasAllowed = () =>
  ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"];

const extraList = () => list("➕ ELIGE UN EXTRA ($15)", [{
  title: "EXTRAS DISPONIBLES",
  rows: extrasAllowed().map(e => ({
    id: e,
    title: e.charAt(0).toUpperCase() + e.slice(1)
  }))
}]);

// 6. ¿OTRO EXTRA?
const askMoreExtras = () => buttons("➕ ¿OTRO EXTRA?", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

// 7. ¿OTRA PIZZA?
const anotherPizza = () => buttons("🍕 ¿OTRA PIZZA?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

// 8. MÉTODO DE ENTREGA
const deliveryButtons = () => buttons("🚚 MÉTODO DE ENTREGA", [
  { id: "domicilio", title: "A domicilio (+$40)" },
  { id: "recoger", title: "Recoger en tienda" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

// =======================
// STEP UI - REENVÍO
// =======================
const stepUI = (s) => {
  switch (s.step) {
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s.currentPizza?.type);
    case "ask_cheese_crust": return askCrust();
    case "ask_extra": return askExtra();
    case "choose_extra": return extraList();
    case "more_extras": return askMoreExtras();
    case "another_pizza": return anotherPizza();
    case "delivery_method": return deliveryButtons();
    default: return pizzaList();
  }
};

// =======================
// HELPERS DE MENSAJES
// =======================
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
        reply: { id: o.id, title: o.title.substring(0, 20) }
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

// =======================
// RESUMEN DE PEDIDO
// =======================
const buildSummary = (s) => {
  let total = 0;
  let text = "✅ *PEDIDO CONFIRMADO*\n\n";

  s.pizzas.forEach((p, i) => {
    const pizzaPrice = PRICES[p.type][p.size];
    total += pizzaPrice;
    
    text += `🍕 *${i + 1}. ${p.type.replace("_", " ")}* (${p.size === "grande" ? "Grande" : "Extra grande"})\n`;
    text += `   Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `   🧀 Orilla de queso: +$${PRICES.orilla_queso}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.map(e => 
        e.charAt(0).toUpperCase() + e.slice(1)
      ).join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *Envío a domicilio*: +$${PRICES.envio}\n`;
    text += `📍 Dirección: ${s.address}\n`;
    text += `📞 Teléfono: ${s.phone}\n\n`;
  } else {
    text += `🏪 *Recoger en local*\n`;
    text += `🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += `💰 *TOTAL: $${total}*\n\n`;
  text += `🎉 ¡Gracias por tu pedido!`;
  return textMsg(text);
};

// =======================
// SEND MESSAGE
// =======================
async function sendMessage(to, payload) {
  try {
    const msgs = Array.isArray(payload) ? payload : [payload];
    for (const m of msgs) {
      await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...m
        })
      });
    }
  } catch (error) {
    console.error("❌ Error sendMessage:", error);
  }
}

// =======================
// LIMPIEZA DE SESIONES
// =======================
setInterval(() => {
  const nowTime = now();
  Object.keys(sessions).forEach(key => {
    if (nowTime - sessions[key].lastAction > SESSION_TIMEOUT) {
      delete sessions[key];
      console.log(`🧹 Sesión expirada: ${key}`);
    }
  });
}, 60000);

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
  console.log(`📱 Webhook URL: https://tu-app.onrender.com/webhook`);
});