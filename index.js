import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const users = {};

const pizzas = {
  pepperoni: { G: 130, EG: 180 },
  hawaiana: { G: 150, EG: 210 },
  mexicana: { G: 200, EG: 250 }
};

const extras = ["Queso", "Piña", "Champiñones"];

const sendMessage = async (to, text) => {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
};

app.post("/webhook", async (req, res) => {
  const msg = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return res.sendStatus(200);

  const from = msg.from;
  const text = msg.text?.body?.toLowerCase();

  if (!users[from]) {
    users[from] = {
      step: "menu",
      order: [],
      current: { extras: [] },
      delivery: null
    };

    await sendMessage(from,
      "🍕 Bienvenido a Pizzería Villa\n\n¿Que deseas hacer?\n🛒 Realizar pedido"
    );
    return res.sendStatus(200);
  }

  const user = users[from];

  /* ===== MENÚ ===== */
  if (user.step === "menu" && text.includes("pedido")) {
    user.step = "pizza";
    await sendMessage(from,
      "🍕 Elige tu pizza:\n- Pepperoni\n- Hawaiana\n- Mexicana"
    );
  }

  /* ===== PIZZA ===== */
  else if (user.step === "pizza" && pizzas[text]) {
    user.current.name = text;
    user.step = "size";
    await sendMessage(from, "📏 Tamaño:\n- Grande\n- Extra grande");
  }

  /* ===== TAMAÑO ===== */
  else if (user.step === "size") {
    if (text.includes("extra")) {
      user.current.size = "EG";
    } else {
      user.current.size = "G";
    }
    user.step = "ask_extra";
    await sendMessage(from, "➕ ¿Agregar extra?\nSí / No");
  }

  /* ===== ¿EXTRA? ===== */
  else if (user.step === "ask_extra") {
    if (text === "si") {
      user.step = "choose_extra";
      await sendMessage(from,
        "Elige un extra:\n" + extras.map(e => `- ${e}`).join("\n")
      );
    } else {
      user.order.push(user.current);
      user.current = { extras: [] };
      user.step = "another_pizza";
      await sendMessage(from, "🍕 ¿Deseas otra pizza?\nSí / No");
    }
  }

  /* ===== ELEGIR EXTRA ===== */
  else if (user.step === "choose_extra") {
    user.current.extras.push(text);
    user.step = "more_extra";
    await sendMessage(from, "➕ ¿Agregar otro extra?\nSí / No");
  }

  /* ===== ¿MÁS EXTRAS? ===== */
  else if (user.step === "more_extra") {
    if (text === "si") {
      user.step = "choose_extra";
      await sendMessage(from,
        "Elige otro extra:\n" + extras.map(e => `- ${e}`).join("\n")
      );
    } else {
      user.order.push(user.current);
      user.current = { extras: [] };
      user.step = "another_pizza";
      await sendMessage(from, "🍕 ¿Deseas otra pizza?\nSí / No");
    }
  }

  /* ===== ¿OTRA PIZZA? ===== */
  else if (user.step === "another_pizza") {
    if (text === "si") {
      user.step = "pizza";
      await sendMessage(from,
        "🍕 Elige tu pizza:\n- Pepperoni\n- Hawaiana\n- Mexicana"
      );
    } else {
      user.step = "delivery";
      await sendMessage(from,
        "🚚 ¿Cómo deseas tu pedido?\n- A domicilio\n- Pasar a recoger"
      );
    }
  }

  /* ===== ENTREGA ===== */
  else if (user.step === "delivery") {
    if (text.includes("domicilio")) {
      user.delivery = "domicilio";
      user.step = "address";
      await sendMessage(from, "📍 Escribe tu dirección completa:");
    } else {
      user.delivery = "recoger";
      showSummary(from, user);
      delete users[from];
    }
  }

  /* ===== DIRECCIÓN ===== */
  else if (user.step === "address") {
    user.address = text;
    showSummary(from, user);
    delete users[from];
  }

  res.sendStatus(200);
});

/* ===== RESUMEN ===== */
const showSummary = async (to, user) => {
  let total = 0;
  let msg = "🧾 PEDIDO\n\n";

  user.order.forEach((p, i) => {
    const price = pizzas[p.name][p.size];
    total += price + p.extras.length * 15;

    msg += `🍕 ${i + 1}. ${p.name} ${p.size === "EG" ? "extragrande" : "grande"}\n`;
    if (p.extras.length) msg += `   ➕ Extras: ${p.extras.join(", ")}\n`;
  });

  if (user.delivery === "domicilio") total += 40;

  msg += `\n🚚 Entrega: ${user.delivery}`;
  if (user.address) msg += `\n📍 ${user.address}`;
  msg += `\n\n💰 TOTAL: $${total}`;

  await sendMessage(to, msg);
};

app.listen(process.env.PORT, () =>
  console.log("🤖 Bot activo")
);
