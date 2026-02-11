const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};

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
  orilla_queso: 40,
  extra: 15,
  envio: 40
};

const TEXT_ALLOWED = ["ask_address", "ask_phone", "ask_pickup_name"];

const invalid = (step) => textMsg(
  `⚠️ Opción no válida.\n👉 Estás en el paso: *${step}*\nUsa los botones mostrados.`
);

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

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, startMenu());
      return res.sendStatus(200);
    }

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: [],
        currentPizza: null,
        lastInput: null,
        lastMsgId: null
      };
    }

    const s = sessions[from];
    
    // ANTI-SPAM
    if (s.lastInput === input) return res.sendStatus(200);
    s.lastInput = input;
    
    if (s.lastMsgId === msg.id) return res.sendStatus(200);
    s.lastMsgId = msg.id;

    let reply;

    if (rawText && !TEXT_ALLOWED.includes(s.step)) {
      await sendMessage(from, invalid(s.step));
      await sendMessage(from, stepUI(s));
      return res.sendStatus(200);
    }

    switch (s.step) {

      case "menu":
        s.step = "menu_option";
        reply = startMenu();
        break;

      case "menu_option":
        if (input === "menu") {
          await sendMessage(from, textMsg(
            "📖 MENÚ\n\nPepperoni G $130 | EG $180\nCarnes frías G $170 | EG $220\nHawaiana G $150 | EG $210\nMexicana G $200 | EG $250\n🧀 Orilla de queso +$40\n➕ Extra $15\n🚚 Envío $40"
          ));
          reply = startMenu();
        } else if (input === "pedido") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          reply = pizzaList();
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = merge(invalid(s.step), pizzaList());
          break;
        }
        s.currentPizza.type = input;
        s.step = "size";
        reply = sizeButtons(s);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = merge(invalid(s.step), sizeButtons(s));
          break;
        }
        s.currentPizza.size = input;
        s.currentPizza.crust = false;
        s.step = "ask_crust";
        reply = askCrust();
        break;

      case "ask_crust":
        if (input === "crust_si") {
          s.currentPizza.crust = true;
        } else if (input === "crust_no") {
          s.currentPizza.crust = false;
        } else {
          reply = merge(invalid(s.step), askCrust());
          break;
        }
        s.step = "ask_extra";
        reply = extraAsk();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(invalid(s.step), extraAsk());
        }
        break;

      case "choose_extra":
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = extraMore();
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(invalid(s.step), extraMore());
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          s.step = "delivery_method";
          reply = deliveryButtons();
        } else {
          reply = merge(invalid(s.step), anotherPizza());
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = "Domicilio";
          s.step = "ask_address";
          reply = textMsg("📍 Escribe tu dirección completa:");
        } else if (input === "recoger") {
          s.delivery = "Recoger";
          s.step = "ask_pickup_name";
          reply = textMsg("🙋 Nombre de quien recoge:");
        } else {
          reply = merge(invalid(s.step), deliveryButtons());
        }
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección inválida. Intenta de nuevo:");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg("⚠️ Teléfono inválido. Intenta de nuevo:");
          break;
        }
        s.phone = rawText;
        reply = buildSummary(s, true);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido. Intenta de nuevo:");
          break;
        }
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

// ======================
// UI
// ======================
const startMenu = () => buttons(
  "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?",
  [
    { id: "pedido", title: "🛒 Realizar pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: Object.keys(PRICES)
    .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
    .map(p => ({
      id: p,
      title: `${p.replace("_", " ")} - G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
    }))
}]);

const sizeButtons = (s) => {
  if (!s?.currentPizza?.type) {
    return buttons("📏 Tamaño", [
      { id: "grande", title: "Grande" },
      { id: "extragrande", title: "Extra grande" }
    ]);
  }
  const prices = PRICES[s.currentPizza.type];
  return buttons("📏 Tamaño", [
    { id: "grande", title: `Grande $${prices.grande}` },
    { id: "extragrande", title: `Extra grande $${prices.extragrande}` }
  ]);
};

const askCrust = () => buttons("🧀 ¿Orilla de queso? (+$40)", [
  { id: "crust_si", title: "Sí (+$40)" },
  { id: "crust_no", title: "No" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const extraAsk = () => buttons("➕ ¿Agregar extra? ($15 c/u)", [
  { id: "extra_si", title: "Sí" },
  { id: "extra_no", title: "No" }
]);

const extraMore = () => extraAsk();

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" }
]);

const deliveryButtons = () => buttons("🚚 ¿Cómo deseas tu pedido?", [
  { id: "domicilio", title: "A domicilio (+$40)" },
  { id: "recoger", title: "Recoger en tienda" }
]);

const extraList = () => list("➕ Elige un extra ($15)", [{
  title: "Extras",
  rows: ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"]
    .map(e => ({ id: e, title: e.charAt(0).toUpperCase() + e.slice(1) }))
}]);

const stepUI = (s) => {
  switch (s.step) {
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s);
    case "ask_crust": return askCrust();
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

// ======================
// HELPERS
// ======================
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

// ======================
// RESUMEN
// ======================
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
  return textMsg(text);
};

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