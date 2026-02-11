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

    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    let reply = null;

    // ======================
    // VALIDACIÓN CORREGIDA
    // ======================

    if (
      s.expected?.length &&
      input &&
      !s.expected.includes(input) &&
      !TEXT_ONLY_STEPS.includes(s.step)
    ) {
      await sendMessage(from, textMsg("⚠️ Opción no válida."));

      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);

      return res.sendStatus(200); // 👈 IMPORTANTE: NO reinicia
    }

    // ======================
    // FLUJO
    // ======================

    switch (s.step) {

      case "menu_option":
        if (input === "pedido") {
          s.currentPizza = { extras: [], crust: false };
          s.step = "pizza_type";
          s.expected = ["pepperoni", "carnes_frias", "hawaiana", "mexicana"];
          reply = pizzaList();
        } else {
          reply = mainMenu();
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          await sendMessage(from, textMsg("⚠️ Opción no válida."));
          await sendMessage(from, pizzaList());
          return res.sendStatus(200);
        }

        s.currentPizza.type = input;
        s.step = "size";
        s.expected = ["grande", "extragrande"];
        reply = sizeButtons(input);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          await sendMessage(from, textMsg("⚠️ Opción no válida."));
          await sendMessage(from, sizeButtons(s.currentPizza.type));
          return res.sendStatus(200);
        }

        s.currentPizza.size = input;
        s.step = "ask_crust";
        s.expected = ["crust_si", "crust_no"];
        reply = askCrust();
        break;

      case "ask_crust":
        if (!["crust_si", "crust_no"].includes(input)) {
          await sendMessage(from, textMsg("⚠️ Opción no válida."));
          await sendMessage(from, askCrust());
          return res.sendStatus(200);
        }

        s.currentPizza.crust = input === "crust_si";
        s.step = "ask_extra";
        s.expected = ["extra_si", "extra_no"];
        reply = askExtra();
        break;
    }

    if (reply) {
      await sendMessage(from, reply);
    }

    res.sendStatus(200);

  } catch (error) {
    console.error("❌ Error crítico:", error);
    res.sendStatus(500);
  }
});


// =======================
// REENVÍA EL PASO ACTUAL
// =======================

const resendStep = (s) => {
  switch (s.step) {
    case "menu_option": return mainMenu();
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s.currentPizza?.type);
    case "ask_crust": return askCrust();
    case "ask_extra": return askExtra();
    default: return null;
  }
};
