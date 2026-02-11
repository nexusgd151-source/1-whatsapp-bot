const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

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

const normalize = t =>
  t?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const now = () => Date.now();

const resetSession = (from) => {
  sessions[from] = {
    step: "menu_option",
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
// WEBHOOK GET
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
// WEBHOOK POST
// =======================

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    if (!from) return res.sendStatus(200);

    const rawText = msg.type === "text" ? msg.text?.body?.trim() : null;

    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id ||
      null;

    input = normalize(input);

    // Protección total contra mensajes no válidos
    if (!rawText && !input) {
      await sendMessage(from, textMsg("⚠️ Usa los botones para continuar."));
      return res.sendStatus(200);
    }

    // Crear sesión si no existe o expiró
    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // Cancelar global
    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    // Bloquear texto cuando no corresponde
    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, errorMsg(s.step));
      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);
      return res.sendStatus(200);
    }

    // Evitar spam doble click
    if (s.lastInput === input && input) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    // Validar opciones esperadas
    if (
      s.expected?.length &&
      input &&
      !s.expected.includes(input) &&
      !TEXT_ONLY_STEPS.includes(s.step)
    ) {
      await sendMessage(from, errorMsg(s.step));
      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);
      return res.sendStatus(200);
    }

    let reply = null;

    switch (s.step) {

      case "menu_option":
        if (input === "menu") {
          reply = menuText();
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
        reply = mainMenu();
        break;

      case "pizza_type":
        if (!PRICES[input]) break;
        s.currentPizza.type = input;
        s.step = "size";
        s.expected = ["grande", "extragrande"];
        reply = sizeButtons(input);
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
        reply = askExtra();
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
          reply = textMsg("📍 Escribe tu dirección completa:");
        } else {
          s.delivery = "Recoger";
          s.step = "ask_pickup_name";
          reply = textMsg("🙋 Nombre de quien recoge:");
        }
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección inválida.");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg("⚠️ Teléfono inválido.");
          break;
        }
        s.phone = rawText;
        reply = buildSummary(s, true);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido.");
          break;
        }
        s.pickupName = rawText;
        reply = buildSummary(s, false);
        delete sessions[from];
        break;
    }

    if (!reply) {
      reply = mainMenu();
      s.step = "menu_option";
    }

    await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Error crítico:", error);
    res.sendStatus(500);
  }
});


// =======================
// UI
// =======================

const mainMenu = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "pedido", title: "🛒 Realizar pedido" } },
        { type: "reply", reply: { id: "menu", title: "📖 Ver menú" } },
        { type: "reply", reply: { id: "cancelar", title: "❌ Cancelar pedido" } }
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
            title: `${p.replace("_", " ")}`
          }))
      }]
    }
  }
});

const sizeButtons = (pizzaType) => {
  if (!pizzaType || !PRICES[pizzaType]) return mainMenu();
  const prices = PRICES[pizzaType];

  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "📏 Tamaño" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "grande", title: `Grande $${prices.grande}` } },
          { type: "reply", reply: { id: "extragrande", title: `Extra grande $${prices.extragrande}` } }
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
        { type: "reply", reply: { id: "crust_si", title: "Sí" } },
        { type: "reply", reply: { id: "crust_no", title: "No" } }
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
        { type: "reply", reply: { id: "extra_si", title: "Sí" } },
        { type: "reply", reply: { id: "extra_no", title: "No" } }
      ]
    }
  }
});

const anotherPizza = () => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "🍕 ¿Agregar otra pizza?" },
    action: {
      buttons: [
        { type: "reply", reply: { id: "si", title: "Sí" } },
        { type: "reply", reply: { id: "no", title: "No" } }
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
        { type: "reply", reply: { id: "domicilio", title: "A domicilio (+$40)" } },
        { type: "reply", reply: { id: "recoger", title: "Recoger en tienda" } }
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
        title: "Extras",
        rows: extrasAllowed().map(e => ({
          id: e,
          title: e
        }))
      }]
    }
  }
});

const errorMsg = (step) => ({
  type: "text",
  text: { body: `⚠️ Opción no válida.\nPaso actual: ${step}` }
});

const textMsg = body => ({ type: "text", text: { body } });

const buildSummary = (s, delivery) => {
  let total = 0;
  let text = "✅ *PEDIDO CONFIRMADO*\n\n";

  s.pizzas.forEach((p, i) => {
    const base = PRICES[p.type][p.size];
    total += base;

    text += `🍕 ${i + 1}. ${p.type} (${p.size})\n`;
    text += `Base: $${base}\n`;

    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `Orilla queso: +$${PRICES.orilla_queso}\n`;
    }

    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
    }

    text += "\n";
  });

  if (delivery) {
    total += PRICES.envio;
    text += `🚚 Envío: +$${PRICES.envio}\n`;
    text += `📍 ${s.address}\n`;
    text += `📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 Recoger en tienda\n`;
    text += `🙋 ${s.pickupName}\n\n`;
  }

  text += `💰 TOTAL: $${total}`;
  return textMsg(text);
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
          to,
          ...payload
        })
      }
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("❌ WhatsApp API:", error);
    }

  } catch (error) {
    console.error("❌ sendMessage error:", error);
  }
}


// =======================
// LIMPIEZA SESIONES
// =======================

setInterval(() => {
  const nowTime = now();
  Object.keys(sessions).forEach(key => {
    if (nowTime - sessions[key].lastAction > SESSION_TIMEOUT) {
      delete sessions[key];
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
