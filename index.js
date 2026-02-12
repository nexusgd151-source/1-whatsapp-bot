const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const sessions = {};

const now = () => Date.now();

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

function resetSession(from) {
  delete sessions[from];
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
          reply: { id: b.id, title: b.title }
        }))
      }
    }
  };
}

// MENUS

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

// WEBHOOK

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    let input =
      msg.interactive?.button_reply?.id ||
      msg.text?.body?.toLowerCase();

    if (!sessions[from]) {
      createSession(from);
      await sendMessage(from, pizzaMenu());
      return res.sendStatus(200);
    }

    const session = sessions[from];

    if (input === "cancelar") {
      resetSession(from);
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      return res.sendStatus(200);
    }

    switch (session.step) {

      case "pizza_type":
        if (!["hawaiana","pepperoni","mexicana"].includes(input)) {
          await sendMessage(from, pizzaMenu());
          break;
        }

        session.order.currentPizza = {
          type: input,
          size: null,
          cheese: false
        };

        session.step = "size";
        await sendMessage(from, sizeMenu());
        break;

      case "size":
        if (!["grande","extragrande"].includes(input)) {
          await sendMessage(from, sizeMenu());
          break;
        }

        session.order.currentPizza.size = input;
        session.step = "cheese";
        await sendMessage(from, cheeseMenu());
        break;

      case "cheese":
        if (!["cheese_si","cheese_no"].includes(input)) {
          await sendMessage(from, cheeseMenu());
          break;
        }

        if (input === "cheese_si")
          session.order.currentPizza.cheese = true;

        session.order.pizzas.push(session.order.currentPizza);

        resetSession(from);
        await sendMessage(from, textMsg("✅ Pizza agregada correctamente."));
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
