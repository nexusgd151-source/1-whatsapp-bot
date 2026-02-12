const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};
const SESSION_TIMEOUT = 1000 * 60 * 10; // 10 minutos

// ========================
// UTILIDADES
// ========================

async function sendText(to, text) {
  await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
}

function resetSession(from) {
  delete sessions[from];
}

function createSession(from) {
  sessions[from] = {
    step: "pizza_type",
    lastActivity: Date.now(),
    order: {
      pizzas: [],
      currentPizza: {}
    }
  };
}

function checkTimeout(from) {
  if (!sessions[from]) return;
  if (Date.now() - sessions[from].lastActivity > SESSION_TIMEOUT) {
    delete sessions[from];
  }
}

function updateActivity(from) {
  if (sessions[from]) {
    sessions[from].lastActivity = Date.now();
  }
}

// ========================
// MENÚS
// ========================

async function sendPizzaMenu(to) {
  await sendText(to,
`🍕 *Elige tu pizza:*

1️⃣ Hawaiana - $180
2️⃣ Pepperoni - $170
3️⃣ Mexicana - $190

❌ Cancelar pedido`);
}

async function sendSizeMenu(to) {
  await sendText(to,
`📏 *Elige tamaño:*

1️⃣ Grande
2️⃣ Extra grande (+$50)

❌ Cancelar pedido`);
}

async function sendCheeseMenu(to) {
  await sendText(to,
`🧀 *¿Quieres orilla de queso?* (+$40)

1️⃣ Sí
2️⃣ No

❌ Cancelar pedido`);
}

async function sendAskExtra(to) {
  await sendText(to,
`➕ ¿Deseas agregar extras?

1️⃣ Sí
2️⃣ No

❌ Cancelar pedido`);
}

async function sendExtras(to) {
  await sendText(to,
`🥓 *Elige un extra:*

1️⃣ Jamón - $20
2️⃣ Tocino - $25
3️⃣ Champiñones - $15

❌ Cancelar pedido`);
}

async function sendMoreExtras(to) {
  await sendText(to,
`➕ ¿Agregar otro extra?

1️⃣ Sí
2️⃣ No

❌ Cancelar pedido`);
}

async function sendAnotherPizza(to) {
  await sendText(to,
`🍕 ¿Quieres otra pizza?

1️⃣ Sí
2️⃣ No

❌ Cancelar pedido`);
}

async function sendDeliveryMethod(to) {
  await sendText(to,
`🚚 Método de entrega:

1️⃣ Envío a domicilio
2️⃣ Recoger en tienda

❌ Cancelar pedido`);
}

// ========================
// RESUMEN
// ========================

function calculateTotal(order) {
  let total = 0;

  order.pizzas.forEach(p => {
    total += p.basePrice;
    if (p.size === "Extra grande") total += 50;
    if (p.cheeseCrust) total += 40;
    p.extras.forEach(e => total += e.price);
  });

  return total;
}

function buildSummary(order) {
  let text = "🧾 *RESUMEN DE TU PEDIDO:*\n\n";

  order.pizzas.forEach((p, i) => {
    text += `🍕 Pizza ${i + 1}: ${p.type} - ${p.size}\n`;
    if (p.cheeseCrust) text += "🧀 Orilla de queso\n";
    p.extras.forEach(e => text += `➕ ${e.name}\n`);
    text += "\n";
  });

  text += `💰 Total: $${calculateTotal(order)}\n\n`;
  text += `📦 Entrega: ${order.delivery}\n`;

  if (order.address) text += `📍 Dirección: ${order.address}\n`;
  text += `📱 Teléfono: ${order.phone}\n\n`;
  text += "1️⃣ Confirmar pedido\n2️⃣ Cancelar pedido";

  return text;
}

// ========================
// WEBHOOK
// ========================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);

    const from = entry.from;
    const message = entry.text?.body?.trim().toLowerCase();
    if (!message) return res.sendStatus(200);

    checkTimeout(from);

    if (!sessions[from]) {
      createSession(from);
      await sendPizzaMenu(from);
      return res.sendStatus(200);
    }

    updateActivity(from);

    // CANCELAR GLOBAL
    if (message.includes("cancelar") || message === "2" && sessions[from].step === "summary") {
      resetSession(from);
      await sendText(from, "❌ Pedido cancelado.\nEscribe cualquier mensaje para iniciar nuevamente.");
      return res.sendStatus(200);
    }

    const session = sessions[from];
    const step = session.step;

    // ========================
    // FLUJO
    // ========================

    if (step === "pizza_type") {
      const pizzas = {
        "1": { name: "Hawaiana", price: 180 },
        "2": { name: "Pepperoni", price: 170 },
        "3": { name: "Mexicana", price: 190 }
      };

      if (!pizzas[message]) {
        await sendText(from, "⚠️ Opción no válida.");
        return sendPizzaMenu(from);
      }

      session.order.currentPizza = {
        type: pizzas[message].name,
        basePrice: pizzas[message].price,
        size: "",
        cheeseCrust: false,
        extras: []
      };

      session.step = "size";
      return sendSizeMenu(from);
    }

    if (step === "size") {
      if (message === "1") session.order.currentPizza.size = "Grande";
      else if (message === "2") session.order.currentPizza.size = "Extra grande";
      else {
        await sendText(from, "⚠️ Opción no válida.");
        return sendSizeMenu(from);
      }

      session.step = "ask_cheese_crust";
      return sendCheeseMenu(from);
    }

    if (step === "ask_cheese_crust") {
      if (message === "1") session.order.currentPizza.cheeseCrust = true;
      else if (message !== "2") {
        await sendText(from, "⚠️ Opción no válida.");
        return sendCheeseMenu(from);
      }

      session.step = "ask_extra";
      return sendAskExtra(from);
    }

    if (step === "ask_extra") {
      if (message === "1") {
        session.step = "choose_extra";
        return sendExtras(from);
      } else if (message === "2") {
        session.order.pizzas.push(session.order.currentPizza);
        session.step = "another_pizza";
        return sendAnotherPizza(from);
      } else {
        await sendText(from, "⚠️ Opción no válida.");
        return sendAskExtra(from);
      }
    }

    if (step === "choose_extra") {
      const extras = {
        "1": { name: "Jamón", price: 20 },
        "2": { name: "Tocino", price: 25 },
        "3": { name: "Champiñones", price: 15 }
      };

      if (!extras[message]) {
        await sendText(from, "⚠️ Opción no válida.");
        return sendExtras(from);
      }

      session.order.currentPizza.extras.push(extras[message]);
      session.step = "more_extras";
      return sendMoreExtras(from);
    }

    if (step === "more_extras") {
      if (message === "1") {
        session.step = "choose_extra";
        return sendExtras(from);
      } else if (message === "2") {
        session.order.pizzas.push(session.order.currentPizza);
        session.step = "another_pizza";
        return sendAnotherPizza(from);
      } else {
        await sendText(from, "⚠️ Opción no válida.");
        return sendMoreExtras(from);
      }
    }

    if (step === "another_pizza") {
      if (message === "1") {
        session.step = "pizza_type";
        return sendPizzaMenu(from);
      } else if (message === "2") {
        session.step = "delivery_method";
        return sendDeliveryMethod(from);
      } else {
        await sendText(from, "⚠️ Opción no válida.");
        return sendAnotherPizza(from);
      }
    }

    if (step === "delivery_method") {
      if (message === "1") {
        session.order.delivery = "Domicilio";
        session.step = "ask_address";
        return sendText(from, "📍 Escribe tu dirección completa:\n\n❌ Cancelar pedido");
      } else if (message === "2") {
        session.order.delivery = "Recoger en tienda";
        session.step = "ask_phone";
        return sendText(from, "📱 Escribe tu número de teléfono:\n\n❌ Cancelar pedido");
      } else {
        await sendText(from, "⚠️ Opción no válida.");
        return sendDeliveryMethod(from);
      }
    }

    if (step === "ask_address") {
      session.order.address = message;
      session.step = "ask_phone";
      return sendText(from, "📱 Escribe tu número de teléfono:\n\n❌ Cancelar pedido");
    }

    if (step === "ask_phone") {
      session.order.phone = message;
      session.step = "summary";
      return sendText(from, buildSummary(session.order));
    }

    if (step === "summary") {
      if (message === "1") {
        resetSession(from);
        return sendText(from, "✅ Pedido confirmado. ¡Gracias por tu compra!");
      }
    }

    return res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log("Servidor corriendo en puerto 3000"));
