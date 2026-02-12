const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const SESSION_TIMEOUT = 10 * 60 * 1000;
const sessions = {};

// ============================
// UTILIDADES
// ============================

const now = () => Date.now();

function resetSession(from) {
  delete sessions[from];
}

function createSession(from) {
  sessions[from] = {
    step: "pizza_type",
    lastAction: now(),
    order: {
      pizzas: [],
      currentPizza: null
    }
  };
}

function expired(session) {
  return now() - session.lastAction > SESSION_TIMEOUT;
}

async function sendMessage(to, payload) {
  await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
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
  });
}

function textMsg(body) {
  return { type: "text", text: { body } };
}

function buttonsMsg(text, buttons) {
  return {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: buttons.map(b => ({
          type: "reply",
          reply: {
            id: b.id,
            title: b.title
          }
        }))
      }
    }
  };
}

// ============================
// MENÚS
// ============================

const pizzaMenu = () =>
  buttonsMsg("🍕 Elige tu pizza:", [
    { id: "hawaiana", title: "Hawaiana $180" },
    { id: "pepperoni", title: "Pepperoni $170" },
    { id: "mexicana", title: "Mexicana $190" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const sizeMenu = () =>
  buttonsMsg("📏 Tamaño:", [
    { id: "grande", title: "Grande" },
    { id: "extragrande", title: "Extra grande +$50" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const cheeseMenu = () =>
  buttonsMsg("🧀 ¿Agregar orilla de queso? (+$40)", [
    { id: "cheese_si", title: "Sí" },
    { id: "cheese_no", title: "No" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const askExtraMenu = () =>
  buttonsMsg("➕ ¿Agregar extras?", [
    { id: "extra_si", title: "Sí" },
    { id: "extra_no", title: "No" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const extrasMenu = () =>
  buttonsMsg("🥓 Elige un extra:", [
    { id: "jamon", title: "Jamón $20" },
    { id: "tocino", title: "Tocino $25" },
    { id: "champi", title: "Champiñones $15" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const moreExtrasMenu = () =>
  buttonsMsg("➕ ¿Agregar otro extra?", [
    { id: "extra_si", title: "Sí" },
    { id: "extra_no", title: "No" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const anotherPizzaMenu = () =>
  buttonsMsg("🍕 ¿Agregar otra pizza?", [
    { id: "si", title: "Sí" },
    { id: "no", title: "No" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

const deliveryMenu = () =>
  buttonsMsg("🚚 Método de entrega:", [
    { id: "domicilio", title: "A domicilio" },
    { id: "recoger", title: "Recoger" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);

// ============================
// RESUMEN
// ============================

function calculateTotal(order) {
  let total = 0;

  order.pizzas.forEach(p => {
    total += p.basePrice;
    if (p.size === "extragrande") total += 50;
    if (p.cheese) total += 40;
    p.extras.forEach(e => total += e.price);
  });

  return total;
}

function buildSummary(order) {
  let text = "🧾 RESUMEN:\n\n";

  order.pizzas.forEach((p, i) => {
    text += `🍕 ${i + 1}. ${p.type} (${p.size})\n`;
    if (p.cheese) text += "   🧀 Orilla de queso\n";
    p.extras.forEach(e => text += `   ➕ ${e.name}\n`);
    text += "\n";
  });

  text += `💰 Total: $${calculateTotal(order)}\n\n`;
  text += `🚚 ${order.delivery}\n`;
  if (order.address) text += `📍 ${order.address}\n`;
  text += `📞 ${order.phone}\n`;

  return buttonsMsg(text, [
    { id: "confirmar", title: "Confirmar" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
}

// ============================
// WEBHOOK
// ============================

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    const input =
      msg.interactive?.button_reply?.id;

    if (!input) return res.sendStatus(200);

    if (!sessions[from]) createSession(from);
    const session = sessions[from];

    if (expired(session)) {
      resetSession(from);
      createSession(from);
      await sendMessage(from, pizzaMenu());
      return res.sendStatus(200);
    }

    session.lastAction = now();

    if (input === "cancelar") {
      resetSession(from);
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      return res.sendStatus(200);
    }

    // ================= FLOW =================

    switch (session.step) {

      case "pizza_type":
        const prices = {
          hawaiana: 180,
          pepperoni: 170,
          mexicana: 190
        };

        if (!prices[input]) {
          await sendMessage(from, pizzaMenu());
          break;
        }

        session.order.currentPizza = {
          type: input,
          basePrice: prices[input],
          size: null,
          cheese: false,
          extras: []
        };

        session.step = "size";
        await sendMessage(from, sizeMenu());
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          await sendMessage(from, sizeMenu());
          break;
        }

        session.order.currentPizza.size = input;
        session.step = "ask_cheese";
        await sendMessage(from, cheeseMenu());
        break;

      case "ask_cheese":
        if (!["cheese_si", "cheese_no"].includes(input)) {
          await sendMessage(from, cheeseMenu());
          break;
        }

        if (input === "cheese_si")
          session.order.currentPizza.cheese = true;

        session.step = "ask_extra";
        await sendMessage(from, askExtraMenu());
        break;

      case "ask_extra":
        if (!["extra_si", "extra_no"].includes(input)) {
          await sendMessage(from, askExtraMenu());
          break;
        }

        if (input === "extra_si") {
          session.step = "choose_extra";
          await sendMessage(from, extrasMenu());
        } else {
          session.order.pizzas.push(session.order.currentPizza);
          session.step = "another_pizza";
          await sendMessage(from, anotherPizzaMenu());
        }
        break;

      case "choose_extra":
        const extras = {
          jamon: { name: "Jamón", price: 20 },
          tocino: { name: "Tocino", price: 25 },
          champi: { name: "Champiñones", price: 15 }
        };

        if (!extras[input]) {
          await sendMessage(from, extrasMenu());
          break;
        }

        session.order.currentPizza.extras.push(extras[input]);
        session.step = "more_extras";
        await sendMessage(from, moreExtrasMenu());
        break;

      case "more_extras":
        if (input === "extra_si") {
          session.step = "choose_extra";
          await sendMessage(from, extrasMenu());
        } else {
          session.order.pizzas.push(session.order.currentPizza);
          session.step = "another_pizza";
          await sendMessage(from, anotherPizzaMenu());
        }
        break;

      case "another_pizza":
        if (input === "si") {
          session.step = "pizza_type";
          await sendMessage(from, pizzaMenu());
        } else {
          session.step = "delivery";
          await sendMessage(from, deliveryMenu());
        }
        break;

      case "delivery":
        if (!["domicilio", "recoger"].includes(input)) {
          await sendMessage(from, deliveryMenu());
          break;
        }

        session.order.delivery = input === "domicilio"
          ? "Entrega a domicilio"
          : "Recoger en tienda";

        session.step = "ask_phone";
        await sendMessage(from, textMsg("📞 Escribe tu número de teléfono:"));
        break;

      case "ask_phone":
        session.order.phone = input;
        session.step = "summary";
        await sendMessage(from, buildSummary(session.order));
        break;

      case "summary":
        if (input === "confirmar") {
          resetSession(from);
          await sendMessage(from, textMsg("✅ Pedido confirmado."));
        }
        break;
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Bot corriendo")
);
