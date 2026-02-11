import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// =====================
// ENV
// =====================
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.PHONE_NUMBER_ID;

// =====================
// SESIONES
// =====================
const sessions = {};
const SESSION_TTL = 5 * 60 * 1000; // 5 minutos

function getSession(user) {
  if (!sessions[user] || Date.now() - sessions[user].last > SESSION_TTL) {
    sessions[user] = {
      step: "start",
      order: [],
      total: 0,
      expected: [],
      last: Date.now(),
    };
  }
  sessions[user].last = Date.now();
  return sessions[user];
}

function resetSession(user) {
  delete sessions[user];
}

// =====================
// WHATSAPP SEND
// =====================
async function sendMessage(to, payload) {
  await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        ...payload,
      }),
    }
  );
}

const textMsg = (body) => ({ text: { body } });

const buttons = (text, buttons) => ({
  interactive: {
    type: "button",
    body: { text },
    action: {
      buttons: buttons.map((b, i) => ({
        type: "reply",
        reply: { id: b.id, title: b.title },
      })),
    },
  },
});

// =====================
// MENÚ
// =====================
const MENU_TEXT = `
🍕 *MENÚ PIZZERÍA VILLA*

Hawaiana
• Ch $120
• G $180
• XG $225

Pepperoni
• Ch $110
• G $170
• XG $215

🧀 Orilla de queso +$40
`;

const mainMenu = () =>
  buttons("¿Qué deseas hacer?", [
    { id: "order", title: "🛒 Realizar pedido" },
    { id: "menu", title: "📋 Ver menú" },
    { id: "cancel", title: "❌ Cancelar pedido" },
  ]);

// =====================
// VALIDACIONES
// =====================
const GLOBAL_ALLOWED = ["menu", "cancel"];

function textAllowed(step) {
  return ["pickup_name", "phone", "address"].includes(step);
}

function errorMsg(step) {
  return textMsg(
    `⚠️ Opción no válida.\n👉 Estás en este paso.\nUsa los botones 👇`
  );
}

// =====================
// RESEND STEP
// =====================
async function resend(user, s) {
  switch (s.step) {
    case "start":
      return sendMessage(user, mainMenu());

    case "pizza_type":
      s.expected = ["hawaiana", "pepperoni"];
      return sendMessage(
        user,
        buttons("🍕 Elige tu pizza", [
          { id: "hawaiana", title: "Hawaiana $225" },
          { id: "pepperoni", title: "Pepperoni $215" },
          { id: "cancel", title: "❌ Cancelar pedido" },
        ])
      );

    case "crust":
      s.expected = ["yes", "no"];
      return sendMessage(
        user,
        buttons("🧀 ¿Orilla de queso? (+$40)", [
          { id: "yes", title: "Sí" },
          { id: "no", title: "No" },
          { id: "cancel", title: "❌ Cancelar pedido" },
        ])
      );

    case "extras":
      s.expected = ["yes", "no"];
      return sendMessage(
        user,
        buttons("➕ ¿Deseas extras?", [
          { id: "yes", title: "Sí" },
          { id: "no", title: "No" },
          { id: "cancel", title: "❌ Cancelar pedido" },
        ])
      );

    case "delivery":
      s.expected = ["pickup", "home"];
      return sendMessage(
        user,
        buttons("🚚 ¿Cómo deseas tu pedido?", [
          { id: "pickup", title: "Recoger en tienda" },
          { id: "home", title: "A domicilio" },
          { id: "cancel", title: "❌ Cancelar pedido" },
        ])
      );

    case "pickup_name":
      return sendMessage(
        user,
        textMsg("👤 Escribe el nombre de quien recogerá la pizza:")
      );

    case "confirm":
      return sendMessage(
        user,
        textMsg(
          `✅ *PEDIDO CONFIRMADO*\n\n${s.order.join(
            "\n"
          )}\n\n💰 TOTAL: $${s.total}\n\n🍕 ¡Gracias por tu pedido!`
        )
      );
  }
}

// =====================
// WEBHOOK
// =====================
app.post("/webhook", async (req, res) => {
  const msg =
    req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const from = msg.from;
  const input =
    msg.type === "interactive"
      ? msg.interactive.button_reply.id
      : msg.text?.body?.toLowerCase().trim();

  const s = getSession(from);

  // CANCELAR
  if (input === "cancel") {
    resetSession(from);
    await sendMessage(from, textMsg("❌ Pedido cancelado."));
    await sendMessage(from, mainMenu());
    return res.sendStatus(200);
  }

  // VER MENU (SIEMPRE)
  if (input === "menu") {
    await sendMessage(from, textMsg(MENU_TEXT));
    await sendMessage(from, mainMenu());
    return res.sendStatus(200);
  }

  // VALIDACIÓN
  if (
    s.expected.length &&
    !s.expected.includes(input) &&
    !textAllowed(s.step)
  ) {
    await sendMessage(from, errorMsg(s.step));
    await resend(from, s);
    return res.sendStatus(200);
  }

  // =====================
  // FLOW
  // =====================
  switch (s.step) {
    case "start":
      if (input === "order") {
        s.step = "pizza_type";
        return resend(from, s);
      }
      return resend(from, s);

    case "pizza_type":
      s.order.push(`🍕 Pizza ${input}`);
      s.total += input === "hawaiana" ? 225 : 215;
      s.step = "crust";
      return resend(from, s);

    case "crust":
      if (input === "yes") {
        s.order.push("🧀 Orilla de queso");
        s.total += 40;
      }
      s.step = "extras";
      return resend(from, s);

    case "extras":
      s.step = "delivery";
      return resend(from, s);

    case "delivery":
      if (input === "pickup") {
        s.step = "pickup_name";
        return resend(from, s);
      }
      break;

    case "pickup_name":
      s.order.push(`👤 Recoge: ${msg.text.body}`);
      s.step = "confirm";
      return resend(from, s);
  }

  res.sendStatus(200);
});

// =====================
app.listen(3000, () =>
  console.log("🍕 Bot activo en puerto 3000")
);
