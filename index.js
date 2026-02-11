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

    if (!rawText && !input) {
      await sendMessage(from, textMsg("⚠️ Usa los botones para continuar."));
      return res.sendStatus(200);
    }

    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, mainMenu());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, errorMsg(s.step));
      const stepUI = resendStep(s);
      if (stepUI) await sendMessage(from, stepUI);
      return res.sendStatus(200);
    }

    if (s.lastInput === input && input) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    // 🔥 VALIDACIÓN CON REENVÍO AUTOMÁTICO
    if (
      s.expected?.length &&
      input &&
      !s.expected.includes(input) &&
      !TEXT_ONLY_STEPS.includes(s.step)
    ) {
      await sendMessage(from, errorMsg(s.step));

      const stepUI = resendStep(s);
      if (stepUI) {
        await sendMessage(from, stepUI);
      }

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
// REENVÍO DE PASO ACTUAL
// =======================

const resendStep = (s) => {
  switch (s.step) {
    case "menu_option":
      return mainMenu();
    case "pizza_type":
      return pizzaList();
    case "size":
      return sizeButtons(s.currentPizza?.type);
    case "ask_crust":
      return askCrust();
    case "ask_extra":
      return askExtra();
    case "choose_extra":
      return extraList();
    case "more_extras":
      return askExtra();
    case "another_pizza":
      return anotherPizza();
    case "delivery_method":
      return deliveryButtons();
    default:
      return mainMenu();
  }
};
