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

// 🔥 NÚMERO DE LA PIZZERÍA
const BUSINESS_NUMBER = "5216391759607";

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
    step: "welcome",
    pizzas: [],
    currentPizza: { extras: [], crust: false },
    lastAction: now(),
    lastInput: null,
    clientNumber: from
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
// TEST - ENVIAR AL NEGOCIO
// =======================
app.get("/test-business", async (req, res) => {
  console.log("🧪 Test: Intentando enviar mensaje al negocio");
  try {
    const testMessage = {
      type: "text",
      text: { body: "🧪 *MENSAJE DE PRUEBA*\n\nSi ves esto, el bot puede enviar mensajes al negocio.\n\n🕒 Hora: " + new Date().toLocaleString('es-MX') }
    };
    
    console.log(`📤 Enviando a ${BUSINESS_NUMBER}:`, testMessage);
    
    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: BUSINESS_NUMBER,
        ...testMessage
      })
    });

    const responseData = await response.json();
    
    if (!response.ok) {
      console.error("❌ Error WhatsApp API:", responseData);
      res.send(`❌ Error: ${JSON.stringify(responseData)}`);
    } else {
      console.log("✅ Mensaje de prueba enviado:", responseData);
      res.send(`✅ Mensaje enviado a ${BUSINESS_NUMBER}`);
    }
  } catch (error) {
    console.error("❌ Error en test:", error);
    res.send(`❌ Error: ${error.message}`);
  }
});

// =======================
// WEBHOOK - POST (TODO TU FLUJO)
// =======================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook POST recibido");
    
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) {
      console.log("ℹ️ No hay mensajes");
      return res.sendStatus(200);
    }

    const msg = value.messages[0];
    const from = msg.from;
    console.log(`📨 Mensaje de ${from}:`, msg);

    const rawText = msg.text?.body;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    if (input) input = normalize(input);

    if (!sessions[from] || isExpired(sessions[from])) {
      console.log(`🆕 Nueva sesión para ${from}`);
      resetSession(from);
      await sendMessage(from, welcomeMessage());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();
    console.log(`📍 Paso actual: ${s.step}, input: ${input}`);

    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      console.log(`🛑 Anti-spam: mismo input repetido`);
      return res.sendStatus(200);
    }
    s.lastInput = input;

    if (input === "cancelar") {
      console.log(`❌ Cancelando pedido de ${from}`);
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado.\n\n¡Esperamos verte pronto! 🍕"));
      await sendMessage(from, welcomeMessage());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      console.log(`⚠️ Texto no permitido en paso: ${s.step}`);
      
      await sendMessage(from, textMsg(`⚠️ Por favor, usa los botones.\n👉 Estás en: *${stepName(s.step)}*`));
      
      const botones = stepUI(s);
      
      if (botones) {
        console.log(`✅ Enviando botones para paso: ${s.step}`);
        await sendMessage(from, botones);
      } else {
        console.log(`⚠️ No hay botones, enviando menú principal`);
        await sendMessage(from, welcomeMessage());
      }
      
      return res.sendStatus(200);
    }

    let reply = null;

    switch (s.step) {

      case "welcome":
        if (input === "pedido") {
          console.log("🛒 Usuario quiere hacer pedido");
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "menu") {
          console.log("📖 Usuario quiere ver menú");
          reply = merge(menuText(), welcomeMessage());
        } else {
          console.log(`❌ Opción no válida en welcome: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), welcomeMessage());
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          console.log(`❌ Pizza no válida: ${input}`);
          reply = merge(textMsg("❌ Pizza no válida"), pizzaList());
          break;
        }
        console.log(`✅ Pizza elegida: ${input}`);
        s.currentPizza.type = input;
        s.currentPizza.extras = [];
        s.currentPizza.crust = false;
        s.step = "size";
        reply = sizeButtons(s.currentPizza.type);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          console.log(`❌ Tamaño no válido: ${input}`);
          reply = merge(textMsg("❌ Tamaño no válido"), sizeButtons(s.currentPizza.type));
          break;
        }
        console.log(`✅ Tamaño elegido: ${input}`);
        s.currentPizza.size = input;
        s.step = "ask_cheese_crust";
        reply = askCrust();
        break;

      case "ask_cheese_crust":
        if (input === "crust_si") {
          console.log("✅ Con orilla de queso");
          s.currentPizza.crust = true;
        } else if (input === "crust_no") {
          console.log("❌ Sin orilla de queso");
          s.currentPizza.crust = false;
        } else {
          console.log(`❌ Opción no válida en orilla: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), askCrust());
          break;
        }
        s.step = "ask_extra";
        reply = askExtra();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          console.log("➕ Usuario quiere extras");
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          console.log("❌ Usuario no quiere extras");
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          console.log(`❌ Opción no válida en ask_extra: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), askExtra());
        }
        break;

      case "choose_extra":
        if (!extrasAllowed().includes(input)) {
          console.log(`❌ Extra no válido: ${input}`);
          reply = merge(textMsg("❌ Extra no válido"), extraList());
          break;
        }
        console.log(`✅ Extra elegido: ${input}`);
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = askMoreExtras();
        break;

      case "more_extras":
        if (input === "extra_si") {
          console.log("➕ Usuario quiere otro extra");
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          console.log("❌ Usuario terminó extras");
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          console.log(`❌ Opción no válida en more_extras: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), askMoreExtras());
        }
        break;

      case "another_pizza":
        if (input === "si") {
          console.log("🍕 Usuario quiere otra pizza");
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          console.log("✅ Usuario terminó pizzas");
          s.step = "delivery_method";
          reply = deliveryButtons();
        } else {
          console.log(`❌ Opción no válida en another_pizza: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), anotherPizza());
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          console.log("🚚 Usuario elige domicilio");
          s.delivery = true;
          s.step = "ask_address";
          reply = textMsg("📍 *A DOMICILIO*\n\nEscribe tu dirección completa:");
        } else if (input === "recoger") {
          console.log("🏪 Usuario elige recoger");
          s.delivery = false;
          s.step = "ask_pickup_name";
          reply = textMsg("🏪 *RECOGER EN TIENDA*\n\nEscribe el nombre de quien recoge:");
        } else {
          console.log(`❌ Opción no válida en delivery_method: ${input}`);
          reply = merge(textMsg("❌ Opción no válida"), deliveryButtons());
        }
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          console.log(`⚠️ Dirección muy corta: ${rawText}`);
          reply = textMsg("⚠️ Dirección muy corta.\nEscribe una dirección válida:");
          break;
        }
        console.log(`📍 Dirección guardada: ${rawText}`);
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 *TELÉFONO*\n\nEscribe tu número de teléfono:");
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          console.log(`⚠️ Teléfono muy corto: ${rawText}`);
          reply = textMsg("⚠️ Número inválido.\nEscribe un teléfono válido:");
          break;
        }
        console.log(`📞 Teléfono guardado: ${rawText}`);
        s.phone = rawText;
        
        const resumenCliente = buildSummary(s);
        const resumenNegocio = buildBusinessSummary(s);
        
        await sendMessage(from, resumenCliente);
        
        console.log(`📨 Intentando enviar a negocio: ${BUSINESS_NUMBER}`);
        await sendMessage(BUSINESS_NUMBER, resumenNegocio);
        console.log(`📨 Pedido enviado a la pizzería: ${BUSINESS_NUMBER}`);
        
        delete sessions[from];
        reply = null;
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          console.log(`⚠️ Nombre muy corto: ${rawText}`);
          reply = textMsg("⚠️ Nombre muy corto.\nEscribe un nombre válido:");
          break;
        }
        console.log(`🙋 Nombre guardado: ${rawText}`);
        s.pickupName = rawText;
        
        const resumenClientePickup = buildSummary(s);
        const resumenNegocioPickup = buildBusinessSummary(s);
        
        await sendMessage(from, resumenClientePickup);
        
        console.log(`📨 Intentando enviar a negocio: ${BUSINESS_NUMBER}`);
        await sendMessage(BUSINESS_NUMBER, resumenNegocioPickup);
        console.log(`📨 Pedido (recoger) enviado a la pizzería: ${BUSINESS_NUMBER}`);
        
        delete sessions[from];
        reply = null;
        break;
    }

    if (reply) {
      console.log(`📤 Enviando respuesta a ${from}`);
      await sendMessage(from, reply);
    }
    
    res.sendStatus(200);

  } catch (e) {
    console.error("❌ Error:", e);
    res.sendStatus(500);
  }
});

// =======================
// FUNCIÓN PARA RESUMEN DEL NEGOCIO
// =======================
const buildBusinessSummary = (s) => {
  let total = 0;
  let text = "🛎️ *NUEVO PEDIDO* 🛎️\n\n";
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  
  text += `👤 *CLIENTE*: ${s.clientNumber}\n\n`;

  s.pizzas.forEach((p, i) => {
    const pizzaPrice = PRICES[p.type][p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   • ${p.type.replace("_", " ")}\n`;
    text += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   • Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `   • 🧀 Orilla de queso: +$${PRICES.orilla_queso}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `   • ➕ Extras: ${p.extras.map(e => 
        e.charAt(0).toUpperCase() + e.slice(1)
      ).join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *ENTREGA*: A domicilio\n`;
    text += `   • Envío: +$${PRICES.envio}\n`;
    text += `   • 📍 Dirección: ${s.address}\n`;
    text += `   • 📞 Teléfono: ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += `🕒 *HORA*: ${new Date().toLocaleString('es-MX')}\n`;
  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += "✨ *Prepáralo con amor* ✨";

  return { type: "text", text: { body: text } };
};

// =======================
// UI AMIGABLE
// =======================
const welcomeMessage = () => buttons(
  "🍕 *BIENVENIDO A PIZZERÍA VILLA* 🍕\n\n¡La mejor pizza de la colonia!\n\n¿Qué deseas hacer hoy?",
  [
    { id: "pedido", title: "🛒 Hacer pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const menuText = () => textMsg(
  "📖 *MENÚ PIZZERÍA VILLA*\n\n" +
  "🍕 *PEPPERONI*\n   • Grande: $130\n   • Extra grande: $180\n\n" +
  "🍕 *CARNES FRÍAS*\n   • Grande: $170\n   • Extra grande: $220\n\n" +
  "🍕 *HAWAIANA*\n   • Grande: $150\n   • Extra grande: $210\n\n" +
  "🍕 *MEXICANA*\n   • Grande: $200\n   • Extra grande: $250\n\n" +
  "🧀 *ORILLA DE QUESO*: +$40\n" +
  "➕ *EXTRAS*: $15 c/u\n" +
  "🚚 *ENVÍO*: $40"
);

const pizzaList = () => list(
  "🍕 *ELIGE TU PIZZA*", [{
    title: "PIZZAS",
    rows: Object.keys(PRICES)
      .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
      .map(p => ({
        id: p,
        title: `🍕 ${p.replace("_", " ")}`,
        description: `G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
      }))
  }]
);

const sizeButtons = (pizzaType) => {
  const prices = PRICES[pizzaType];
  return buttons("📏 *TAMAÑO*", [
    { id: "grande", title: `Grande $${prices.grande}` },
    { id: "extragrande", title: `Extra $${prices.extragrande}` },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const askCrust = () => buttons("🧀 *¿ORILLA DE QUESO?* (+$40)", [
  { id: "crust_si", title: "✅ Sí (+$40)" },
  { id: "crust_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const askExtra = () => buttons("➕ *¿AGREGAR EXTRA?* ($15 c/u)", [
  { id: "extra_si", title: "✅ Sí" },
  { id: "extra_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const extrasAllowed = () =>
  ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"];

const extraList = () => list("➕ *ELIGE UN EXTRA* ($15)", [{
  title: "EXTRAS",
  rows: extrasAllowed().map(e => ({
    id: e,
    title: `• ${e.charAt(0).toUpperCase() + e.slice(1)}`,
    description: "+$15"
  }))
}]);

const askMoreExtras = () => buttons("➕ *¿OTRO EXTRA?*", [
  { id: "extra_si", title: "✅ Sí" },
  { id: "extra_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const anotherPizza = () => buttons("🍕 *¿OTRA PIZZA?*", [
  { id: "si", title: "✅ Sí" },
  { id: "no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const deliveryButtons = () => buttons("🚚 *MÉTODO DE ENTREGA*", [
  { id: "domicilio", title: "🏠 A domicilio (+$40)" },
  { id: "recoger", title: "🏪 Recoger en tienda" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const stepName = (step) => {
  const names = {
    welcome: "Bienvenida",
    pizza_type: "Elegir pizza",
    size: "Tamaño",
    ask_cheese_crust: "Orilla de queso",
    ask_extra: "Extras",
    choose_extra: "Seleccionar extra",
    more_extras: "Otro extra",
    another_pizza: "Otra pizza",
    delivery_method: "Entrega",
    ask_address: "Dirección",
    ask_phone: "Teléfono",
    ask_pickup_name: "Nombre"
  };
  return names[step] || step;
};

const stepUI = (s) => {
  switch (s.step) {
    case "welcome": return welcomeMessage();
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s.currentPizza?.type);
    case "ask_cheese_crust": return askCrust();
    case "ask_extra": return askExtra();
    case "choose_extra": return extraList();
    case "more_extras": return askMoreExtras();
    case "another_pizza": return anotherPizza();
    case "delivery_method": return deliveryButtons();
    default: return welcomeMessage();
  }
};

// =======================
// HELPERS
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
      button: "📋 Ver opciones",
      sections
    }
  }
});

const buildSummary = (s) => {
  let total = 0;
  let text = "✅ *¡PEDIDO CONFIRMADO!* ✅\n\n";
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";

  s.pizzas.forEach((p, i) => {
    const pizzaPrice = PRICES[p.type][p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   • ${p.type.replace("_", " ")}\n`;
    text += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   • Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `   • 🧀 Orilla de queso: +$${PRICES.orilla_queso}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `   • ➕ Extras: ${p.extras.map(e => 
        e.charAt(0).toUpperCase() + e.slice(1)
      ).join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *ENTREGA*: A domicilio\n`;
    text += `   • Envío: +$${PRICES.envio}\n`;
    text += `   • 📍 ${s.address}\n`;
    text += `   • 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += "✨ *¡Gracias por tu pedido!*\n";
  text += "🍕 *Pizzería Villa*";

  return textMsg(text);
};

async function sendMessage(to, payload) {
  try {
    console.log(`📤 Enviando a ${to}:`, JSON.stringify(payload, null, 2));
    
    const msgs = Array.isArray(payload) ? payload : [payload];
    for (const m of msgs) {
      const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
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

      const responseData = await response.json();
      
      if (!response.ok) {
        console.error("❌ Error WhatsApp API:", responseData);
      } else {
        console.log("✅ Mensaje enviado:", responseData);
      }
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
// START
// =======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
  console.log(`📱 Número de la pizzería: ${BUSINESS_NUMBER}`);
  console.log(`🔗 Webhook URL: https://one-whatsapp-bot.onrender.com/webhook`);
  console.log(`🧪 Test endpoint: https://one-whatsapp-bot.onrender.com/test-business`);
});