const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

// ====================
// CONFIG
// ====================
const TOKEN = process.env.TOKEN;
const PHONE_ID = process.env.PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "pizza_token_123";

// ====================
// SESIONES EN MEMORIA
// ====================
const sessions = {};

// ====================
// DATOS
// ====================
const PIZZAS = {
  pepperoni: { g: 130, eg: 180 },
  hawaiana: { g: 150, eg: 210 },
  mexicana: { g: 200, eg: 250 }
};

const EXTRAS = {
  queso: 15,
  pina: 15,
  jalapeno: 15,
  champinones: 15
};

const ENVIO = 40;

// ====================
// NORMALIZAR TEXTO
// ====================
const n = t =>
  t
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

// ====================
// ENVIAR MENSAJE
// ====================
async function sendMessage(to, body) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

// ====================
// VERIFY (META OBLIGATORIO)
// ====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ====================
// WEBHOOK
// ====================
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const text = msg.text?.body ? n(msg.text.body) : "";

    if (!sessions[from]) {
      sessions[from] = {
        step: "menu",
        pizzas: [],
        current: { extras: [] },
        delivery: null,
        address: ""
      };

      await sendMessage(
        from,
        "🍕 Bienvenido a Pizzería Villa\n\n🛒 Escribe: *realizar pedido*"
      );
      return res.sendStatus(200);
    }

    const s = sessions[from];

    // ===== MENU =====
    if (s.step === "menu" && text.includes("pedido")) {
      s.step = "pizza";
      await sendMessage(
        from,
        "🍕 Elige tu pizza:\n- Pepperoni\n- Hawaiana\n- Mexicana"
      );
    }

    // ===== PIZZA =====
    else if (s.step === "pizza" && PIZZAS[text]) {
      s.current.name = text;
      s.step = "size";
      await sendMessage(from, "📏 Tamaño:\n- Grande\n- Extra grande");
    }

    // ===== TAMAÑO =====
    else if (s.step === "size") {
      s.current.size = text.includes("extra") ? "eg" : "g";
      s.step = "ask_extra";
      await sendMessage(from, "➕ ¿Agregar extra?\nSí / No");
    }

    // ===== ¿AGREGAR EXTRA? =====
    else if (s.step === "ask_extra") {
      if (text === "si") {
        s.step = "choose_extra";
        await sendMessage(
          from,
          "Elige un extra:\n- Queso\n- Piña\n- Jalapeño\n- Champiñones"
        );
      } else {
        s.pizzas.push(s.current);
        s.current = { extras: [] };
        s.step = "another_pizza";
        await sendMessage(from, "🍕 ¿Agregar otra pizza?\nSí / No");
      }
    }

    // ===== ELEGIR EXTRA =====
    else if (s.step === "choose_extra" && EXTRAS[text]) {
      s.current.extras.push(text);
      s.step = "more_extra";
      await sendMessage(from, "➕ ¿Agregar otro extra?\nSí / No");
    }

    // ===== ¿OTRO EXTRA? =====
    else if (s.step === "more_extra") {
      if (text === "si") {
        s.step = "choose_extra";
        await sendMessage(
          from,
          "Elige otro extra:\n- Queso\n- Piña\n- Jalapeño\n- Champiñones"
        );
      } else {
        s.pizzas.push(s.current);
        s.current = { extras: [] };
        s.step = "another_pizza";
        await sendMessage(from, "🍕 ¿Agregar otra pizza?\nSí / No");
      }
    }

    // ===== ¿OTRA PIZZA? =====
    else if (s.step === "another_pizza") {
      if (text === "si") {
        s.step = "pizza";
        await sendMessage(
          from,
          "🍕 Elige tu pizza:\n- Pepperoni\n- Hawaiana\n- Mexicana"
        );
      } else {
        s.step = "delivery";
        await sendMessage(
          from,
          "🚚 ¿Cómo deseas tu pedido?\n- A domicilio\n- Pasar a recoger"
        );
      }
    }

    // ===== ENTREGA =====
    else if (s.step === "delivery") {
      if (text.includes("domicilio")) {
        s.delivery = "domicilio";
        s.step = "address";
        await sendMessage(from, "📍 Escribe tu dirección:");
      } else {
        s.delivery = "recoger";
        await summary(from, s);
        delete sessions[from];
      }
    }

    // ===== DIRECCIÓN =====
    else if (s.step === "address") {
      s.address = msg.text.body;
      await summary(from, s);
      delete sessions[from];
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// ====================
// RESUMEN
// ====================
async function summary(to, s) {
  let total = 0;
  let text = "🧾 *PEDIDO FINAL*\n\n";

  s.pizzas.forEach((p, i) => {
    const base = PIZZAS[p.name][p.size];
    const extraCost = p.extras.length * 15;
    total += base + extraCost;

    text += `🍕 ${i + 1}. ${p.name} ${p.size === "eg" ? "extragrande" : "grande"}\n`;
    if (p.extras.length) {
      text += `   ➕ Extras: ${p.extras.join(", ")}\n`;
    }
  });

  if (s.delivery === "domicilio") {
    total += ENVIO;
    text += `\n🚚 Envío: $40\n📍 ${s.address}`;
  } else {
    text += "\n🏪 Pasa a recoger";
  }

  text += `\n\n💰 TOTAL: $${total} MXN`;

  await sendMessage(to, text);
}

// ====================
// START
// ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🤖 Bot activo en puerto", PORT)
);
