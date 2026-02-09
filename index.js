const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};

/* =========================
   UTILIDADES
========================= */

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

const PIZZAS_VALIDAS = Object.keys(PRICES).filter(
  p => !["extra", "envio"].includes(p)
);

/* =========================
   VALIDACIÓN DE PASOS
========================= */

const validInputForStep = (step, input) => {
  const rules = {
    menu_option: ["pedido", "menu"],
    pizza_type: PIZZAS_VALIDAS,
    size: ["grande", "extragrande"],
    ask_extra: ["extra_si", "extra_no"],
    more_extras: ["extra_si", "extra_no"],
    another_pizza: ["si", "no"],
    delivery_method: ["domicilio", "recoger"]
  };
  if (!rules[step]) return true;
  return rules[step].includes(input);
};

const invalidStepMsg = step =>
  textMsg(
    `⚠️ Esa opción ya no es válida.\n\n👉 Actualmente estás en el paso: *${step.replace("_"," ")}*\nPor favor continúa con el pedido.`
  );

/* =========================
   ENDPOINTS
========================= */

app.get("/", (_, res) => res.send("Bot activo 🚀"));

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

    /* 🚫 BLOQUEO DE INTENTOS RAROS */
    if (input && !validInputForStep(s.step, input)) {
      await sendMessage(from, invalidStepMsg(s.step));
      return res.sendStatus(200);
    }

    switch (s.step) {

      case "menu":
        reply = buttons("🍕 Bienvenido a Pizzería Villa\n¿Qué deseas hacer?", [
          { id: "pedido", title: "🛒 Realizar pedido" },
          { id: "menu", title: "📖 Ver menú" }
        ]);
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
        reply = buttons("📏 Tamaño", [
          { id: "grande", title: "Grande" },
          { id: "extragrande", title: "Extra grande" }
        ]);
        break;

      case "size":
        s.currentPizza.size = input;
        s.step = "ask_extra";
        reply = buttons("➕ ¿Agregar extra?", [
          { id: "extra_si", title: "Sí" },
          { id: "extra_no", title: "No" }
        ]);
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
        reply = buttons("➕ ¿Agregar otro extra?", [
          { id: "extra_si", title: "Sí" },
          { id: "extra_no", title: "No" }
        ]);
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
          reply = buttons("🚚 ¿Cómo deseas tu pedido?", [
            { id: "domicilio", title: "A domicilio" },
            { id: "recoger", title: "Recoger en tienda" }
          ]);
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
          reply = textMsg("🙋 ¿Nombre de quien recogerá la pizza?");
        }
        break;

      case "ask_address":
        if (!rawText) break;
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 Escribe tu número de teléfono:");
        break;

      case "ask_phone":
        if (!rawText) break;
        s.phone = rawText;
        reply = buildSummary(s, true);
        delete sessions[from];
        break;

      case "ask_pickup_name":
        if (!rawText) break;
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

/* =========================
   HELPERS
========================= */

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

const pizzaList = () => list("🍕 Elige tu pizza", [{
  title: "Pizzas",
  rows: PIZZAS_VALIDAS.map(p => ({
    id: p,
    title: p.replace("_", " ")
  }))
}]);

const extraList = () => list("➕ Elige un extra ($15)", [{
  title: "Extras",
  rows: ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"]
    .map(e => ({ id: e, title: e }))
}]);

const anotherPizza = () => buttons("🍕 ¿Agregar otra pizza?", [
  { id: "si", title: "Sí" },
  { id: "no", title: "No" }
]);

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
  console.log("🚀 Bot corriendo")
);
