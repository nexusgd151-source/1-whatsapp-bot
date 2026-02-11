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
    step: "menu",
    pizzas: [],
    lastAction: now(),
    expected: [],
    lastInput: null,
    currentPizza: null
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

    const rawText = msg.type === "text" ? msg.text.body : null;
    let input = 
      msg.interactive?.button_reply?.id || 
      msg.interactive?.list_reply?.id;

    input = normalize(input);
    
    console.log(`📩 Mensaje de ${from}:`, { input, step: sessions[from]?.step });

    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // =======================
    // CANCELAR GLOBAL
    // =======================
    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    // =======================
    // PROTECCIÓN ANTI-TONTOS
    // =======================
    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, errorMsg(s.step));
      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);
      return res.sendStatus(200);
    }

    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    if (
      s.expected.length && 
      !s.expected.includes(input) && 
      !TEXT_ONLY_STEPS.includes(s.step)
    ) {
      await sendMessage(from, errorMsg(s.step));
      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);
      return res.sendStatus(200);
    }

    let reply = null;

    // =======================
    // FLUJO PRINCIPAL
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
          break;
        }
        if (input === "pedido") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          s.expected = Object.keys(PRICES).filter(p => 
            !["extra", "envio", "orilla_queso"].includes(p)
          );
          reply = pizzaList();
          break;
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) break;
        s.currentPizza.type = input;
        s.step = "size";
        s.expected = ["grande", "extragrande"];
        reply = sizeButtons(s.currentPizza.type);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) break;
        s.currentPizza.size = input;
        s.step = "ask_crust";
        s.expected = ["crust_si", "crust_no"];
        reply = askCrust();
        break;

      case "ask_crust":
        s.currentPizza.crust = input === "crust_si";
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
          s.pizzas.push({ ...s.currentPizza });
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
          s.pizzas.push({ ...s.currentPizza });
          s.step = "another_pizza";
          s.expected = ["si", "no"];
          reply = anotherPizza();
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          s.expected = Object.keys(PRICES).filter(p => 
            !["extra", "envio", "orilla_queso"].includes(p)
          );
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
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección inválida. Escribe una dirección válida:");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        s.expected = [];
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg("⚠️ Teléfono inválido. Escribe un número válido:");
          break;
        }
        s.phone = rawText;
        reply = buildSummary(s, true);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido. Escribe un nombre válido:");
          break;
        }
        s.pickupName = rawText;
        reply = buildSummary(s, false);
        delete sessions[from];
        break;
    }

    if (reply) {
      console.log(`📤 Enviando a ${from}:`, s.step);
      await sendMessage(from, reply);
    }
    res.sendStatus(200);

  } catch (e) {
    console.error("❌ Error:", e);
    res.sendStatus(500);
  }
});

// =======================
// UI - CORREGIDO CON FORMATO EXPLÍCITO
// =======================
const mainMenu = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "pedido", title: "🛒 Realizar pedido" }
        },
        {
          type: "reply",
          reply: { id: "menu", title: "📖 Ver menú" }
        },
        {
          type: "reply",
          reply: { id: "cancelar", title: "❌ Cancelar pedido" }
        }
      ]
    }
  }
});

const pizzaList = () => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text: "🍕 Elige tu pizza" },
    action: {
      button: "Seleccionar",
      sections: [{
        title: "Pizzas",
        rows: Object.keys(PRICES)
          .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
          .map(p => ({
            id: p,
            title: `${p.replace("_", " ")} - G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
          }))
      }]
    }
  }
});

const sizeButtons = (pizzaType) => {
  const prices = PRICES[pizzaType];
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "📏 Tamaño" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "grande", title: `Grande $${prices.grande}` }
          },
          {
            type: "reply",
            reply: { id: "extragrande", title: `Extra grande $${prices.extragrande}` }
          },
          {
            type: "reply",
            reply: { id: "cancelar", title: "❌ Cancelar pedido" }
          }
        ]
      }
    }
  };
};

const askCrust = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🧀 ¿Agregar orilla de queso? (+$40)" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "crust_si", title: "Sí (+$40)" }
        },
        {
          type: "reply",
          reply: { id: "crust_no", title: "No" }
        },
        {
          type: "reply",
          reply: { id: "cancelar", title: "❌ Cancelar pedido" }
        }
      ]
    }
  }
});

const askExtra = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "➕ ¿Agregar extra? ($15 c/u)" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "extra_si", title: "Sí" }
        },
        {
          type: "reply",
          reply: { id: "extra_no", title: "No" }
        },
        {
          type: "reply",
          reply: { id: "cancelar", title: "❌ Cancelar pedido" }
        }
      ]
    }
  }
});

const askMoreExtras = askExtra;

const anotherPizza = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🍕 ¿Agregar otra pizza?" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "si", title: "Sí" }
        },
        {
          type: "reply",
          reply: { id: "no", title: "No" }
        },
        {
          type: "reply",
          reply: { id: "cancelar", title: "❌ Cancelar pedido" }
        }
      ]
    }
  }
});

const deliveryButtons = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🚚 ¿Cómo deseas tu pedido?" },
    action: {
      buttons: [
        {
          type: "reply",
          reply: { id: "domicilio", title: "A domicilio (+$40)" }
        },
        {
          type: "reply",
          reply: { id: "recoger", title: "Recoger en tienda" }
        },
        {
          type: "reply",
          reply: { id: "cancelar", title: "❌ Cancelar pedido" }
        }
      ]
    }
  }
});

const extrasAllowed = () =>
  ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"];

const extraList = () => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text: "➕ Elige un extra ($15)" },
    action: {
      button: "Seleccionar",
      sections: [{
        title: "Extras disponibles",
        rows: extrasAllowed().map(e => ({ 
          id: e, 
          title: e.charAt(0).toUpperCase() + e.slice(1) 
        }))
      }]
    }
  }
});

// =======================
// HELPERS
// =======================
const resendStep = (s) => {
  switch (s.step) {
    case "menu":
    case "menu_option":
      return mainMenu();
    case "pizza_type":
      return pizzaList();
    case "size":
      return sizeButtons(s.currentPizza?.type);
    case "ask_crust":
      return askCrust();
    case "ask_extra":
      return askExtra();
    case "choose_extra":
      return extraList();
    case "more_extras":
      return askMoreExtras();
    case "another_pizza":
      return anotherPizza();
    case "delivery_method":
      return deliveryButtons();
    default:
      return null;
  }
};

const errorMsg = (step) => ({
  type: "text",
  text: { body: `⚠️ Opción no válida.\n👉 Estás en el paso: *${step}*\nUsa los botones.` }
});

const menuText = () => ({
  type: "text",
  text: { 
    body: "📖 *MENÚ*\n\n" +
    "🍕 Pepperoni: $130 / $180\n" +
    "🍕 Carnes frías: $170 / $220\n" +
    "🍕 Hawaiana: $150 / $210\n" +
    "🍕 Mexicana: $200 / $250\n" +
    "🧀 Orilla de queso: +$40\n" +
    "➕ Extras: $15 c/u\n" +
    "🚚 Envío: $40"
  }
});

const textMsg = body => ({ type: "text", text: { body } });

const buildSummary = (s, delivery) => {
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

  if (delivery) {
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

  return { type: "text", text: { body: text } };
};

// =======================
// SEND MESSAGE
// =======================
async function sendMessage(to, payload) {
  try {
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...payload
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("❌ Error WhatsApp API:", error);
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
});