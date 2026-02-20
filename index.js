const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// CONFIG
// =======================
const SESSION_TIMEOUT = 5 * 60 * 1000;
const BUSINESS_NUMBER = "5216391759607";
const UMBRAL_TRANSFERENCIA = 450; // 🔥 Pedidos >= $450 solo transferencia

// 🔥 HORARIOS
const HORARIO = {
  abierto: { hora: 11, minuto: 0 },  // 11:00 AM
  cerrado: { hora: 21, minuto: 0 },   // 9:00 PM
  diasCerrados: [2] // 0=Domingo, 1=Lunes, 2=MARTES, 3=Miércoles...
};

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

// =======================
// UTILS
// =======================
const normalize = t =>
  t?.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const now = () => Date.now();

const resetSession = (from) => {
  sessions[from] = {
    step: "welcome",
    pizzas: [],
    currentPizza: { extras: [], crust: false },
    lastAction: now(),
    lastInput: null,
    clientNumber: from,
    pendingConfirmation: false, // 🔥 Para confirmación final
    pagoForzado: false,
    totalTemp: 0,
    comprobanteEnviado: false
  };
};

const isExpired = (s) => now() - s.lastAction > SESSION_TIMEOUT;
const TEXT_ONLY_STEPS = ["ask_address", "ask_phone", "ask_pickup_name", "ask_comprobante"];

// =======================
// 🔥 VERIFICAR HORARIO
// =======================
const checkHorario = () => {
  const ahora = new Date();
  const dia = ahora.getDay(); // 0=Domingo, 1=Lunes, 2=Martes...
  const hora = ahora.getHours();
  const minutos = ahora.getMinutes();
  
  // Verificar si es martes (día cerrado)
  if (HORARIO.diasCerrados.includes(dia)) {
    return { abierto: false, razon: "cerrado_todo_el_dia" };
  }
  
  // Convertir a minutos desde medianoche
  const minutosActuales = hora * 60 + minutos;
  const minutosApertura = HORARIO.abierto.hora * 60 + HORARIO.abierto.minuto;
  const minutosCierre = HORARIO.cerrado.hora * 60 + HORARIO.cerrado.minuto;
  
  if (minutosActuales >= minutosApertura && minutosActuales < minutosCierre) {
    return { abierto: true };
  } else {
    return { abierto: false, razon: "fuera_horario" };
  }
};

// =======================
// WEBHOOK - GET
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
// TEST
// =======================
app.get("/test-business", async (req, res) => {
  try {
    await sendMessage(BUSINESS_NUMBER, { type: "text", text: { body: "🧪 Prueba" } });
    res.send("✅ OK");
  } catch (error) {
    res.send(`❌ Error: ${error.message}`);
  }
});

// =======================
// WEBHOOK - POST
// =======================
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook POST recibido");
    
    // 🔥 VERIFICAR HORARIO AL INICIO
    const horario = checkHorario();
    
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    // Si es mensaje de ubicación
    if (msg.type === "location") {
      const ubicacion = `📍 *UBICACIÓN RECIBIDA*\n\nLat: ${msg.location.latitude}\nLng: ${msg.location.longitude}`;
      await sendMessage(from, textMsg(ubicacion));
      
      if (sessions[from]) {
        sessions[from].address = `https://maps.google.com/?q=${msg.location.latitude},${msg.location.longitude}`;
        sessions[from].step = "ask_phone";
        await sendMessage(from, textMsg("📞 *TELÉFONO*\n\nEscribe tu número:"));
      }
      return res.sendStatus(200);
    }

    const rawText = msg.text?.body;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    if (input) input = normalize(input);

    // 🔥 BLOQUEAR SI ESTÁ CERRADO (excepto si ya tiene sesión)
    if (!sessions[from] && !horario.abierto) {
      let mensaje = "🕒 *FUERA DE HORARIO*\n\n";
      if (horario.razon === "cerrado_todo_el_dia") {
        mensaje += "Hoy es MARTES, estamos CERRADOS.\n\n";
      } else {
        mensaje += `Nuestro horario es:\nLunes a Domingo: 11:00 AM - 9:00 PM\n(Martes cerrado)`;
      }
      await sendMessage(from, textMsg(mensaje));
      return res.sendStatus(200);
    }

    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, welcomeMessage());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado.\n\n¡Esperamos verte pronto! 🍕"));
      await sendMessage(from, welcomeMessage());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, textMsg(`⚠️ Por favor, usa los botones.`));
      const botones = stepUI(s);
      if (botones) await sendMessage(from, botones);
      return res.sendStatus(200);
    }

    let reply = null;

    switch (s.step) {

      case "welcome":
        if (input === "pedido") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "menu") {
          reply = merge(menuText(), welcomeMessage());
        } else {
          reply = merge(textMsg("❌ Opción no válida"), welcomeMessage());
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = merge(textMsg("❌ Pizza no válida"), pizzaList());
          break;
        }
        s.currentPizza.type = input;
        s.currentPizza.extras = [];
        s.currentPizza.crust = false;
        s.step = "size";
        reply = sizeButtons(s.currentPizza.type);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          reply = merge(textMsg("❌ Tamaño no válido"), sizeButtons(s.currentPizza.type));
          break;
        }
        s.currentPizza.size = input;
        s.step = "ask_cheese_crust";
        reply = askCrust();
        break;

      case "ask_cheese_crust":
        if (input === "crust_si") {
          s.currentPizza.crust = true;
        } else if (input === "crust_no") {
          s.currentPizza.crust = false;
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askCrust());
          break;
        }
        s.step = "ask_extra";
        reply = askExtra();
        break;

      case "ask_extra":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askExtra());
        }
        break;

      case "choose_extra":
        if (!extrasAllowed().includes(input)) {
          reply = merge(textMsg("❌ Extra no válido"), extraList());
          break;
        }
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = askMoreExtras();
        break;

      case "more_extras":
        if (input === "extra_si") {
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), askMoreExtras());
        }
        break;

      case "another_pizza":
        if (input === "si") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          s.step = "delivery_method";
          reply = deliveryButtons();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), anotherPizza());
        }
        break;

      case "delivery_method":
        if (input === "domicilio") {
          s.delivery = true;
          
          // Calcular total para verificar umbral
          s.totalTemp = calcularTotal(s);
          
          if (s.totalTemp >= UMBRAL_TRANSFERENCIA) {
            s.pagoForzado = true;
            s.step = "ask_payment";
            reply = paymentForzadoMessage(s.totalTemp);
          } else {
            s.step = "ask_payment";
            reply = paymentOptions();
          }
        } else if (input === "recoger") {
          s.delivery = false;
          s.totalTemp = calcularTotal(s);
          s.step = "ask_payment";
          reply = paymentOptions();
        } else {
          reply = merge(textMsg("❌ Opción no válida"), deliveryButtons());
        }
        break;

      // 🔥 PASO DE PAGO
      case "ask_payment":
        if (s.pagoForzado) {
          if (input !== "pago_transferencia") {
            reply = merge(
              textMsg(`❌ Pedidos > $${UMBRAL_TRANSFERENCIA} solo transferencia`),
              paymentForzadoMessage(s.totalTemp)
            );
            break;
          }
          s.pagoMetodo = "Transferencia";
        } else {
          if (input === "pago_efectivo") {
            s.pagoMetodo = "Efectivo";
          } else if (input === "pago_transferencia") {
            s.pagoMetodo = "Transferencia";
          } else {
            reply = merge(textMsg("❌ Selecciona método"), paymentOptions());
            break;
          }
        }
        
        if (s.delivery) {
          s.step = "ask_location_or_address";
          reply = locationOrAddress();
        } else {
          s.step = "ask_pickup_name";
          reply = textMsg("🏪 *RECOGER*\n\nEscribe el nombre de quien recoge:");
        }
        break;

      // 🔥 NUEVO: ELEGIR UBICACIÓN O DIRECCIÓN
      case "ask_location_or_address":
        if (input === "ubicacion") {
          s.step = "ask_location";
          reply = textMsg("📍 *COMPARTE UBICACIÓN*\n\nPresiona el clip 📎 → Ubicación");
        } else if (input === "direccion") {
          s.step = "ask_address";
          reply = textMsg("📝 *DIRECCIÓN*\n\nEscribe tu dirección completa:");
        } else {
          reply = merge(textMsg("❌ Opción no válida"), locationOrAddress());
        }
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección muy corta. Intenta de nuevo:");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 *TELÉFONO*\n\nEscribe tu número:");
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg("⚠️ Teléfono inválido. Intenta de nuevo:");
          break;
        }
        s.phone = rawText;
        
        // 🔥 CONFIRMACIÓN FINAL
        s.step = "confirmacion_final";
        reply = confirmacionFinal(s);
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido. Intenta de nuevo:");
          break;
        }
        s.pickupName = rawText;
        
        // 🔥 CONFIRMACIÓN FINAL
        s.step = "confirmacion_final";
        reply = confirmacionFinal(s);
        break;

      // 🔥 CONFIRMACIÓN FINAL
      case "confirmacion_final":
        if (input === "confirmar") {
          // Si pago es transferencia, pedir comprobante
          if (s.pagoMetodo === "Transferencia") {
            s.step = "ask_comprobante";
            reply = textMsg(
              "🧾 *COMPROBANTE DE PAGO*\n\n" +
              "📲 Datos para transferencia:\n" +
              "🏦 Banco: BBVA\n" +
              "👤 Titular: Pizzería Villa\n" +
              "💰 Cuenta: 1234 5678 9012 3456\n" +
              "📝 Referencia: PED-" + Date.now().toString().slice(-6) + "\n\n" +
              "✅ *Envíanos la foto del comprobante* cuando hayas pagado."
            );
          } else {
            // Efectivo: enviar pedido directo
            await finalizarPedido(s, from);
            reply = null;
          }
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(
            textMsg("❌ Pedido cancelado."),
            welcomeMessage()
          );
        } else {
          reply = merge(textMsg("❌ Opción no válida"), confirmacionFinal(s));
        }
        break;

      // 🔥 RECIBIR COMPROBANTE
      case "ask_comprobante":
        if (msg.type === "image" || msg.type === "document") {
          // Tiene imagen = comprobante válido
          await sendMessage(from, textMsg("✅ *COMPROBANTE RECIBIDO*\n\nProcesando pedido..."));
          await finalizarPedido(s, from);
          reply = null;
        } else {
          reply = textMsg("⚠️ *ENVÍA LA IMAGEN DEL COMPROBANTE*\n\nPresiona clip 📎 → Imagen");
        }
        break;
    }

    if (reply) await sendMessage(from, reply);
    res.sendStatus(200);

  } catch (e) {
    console.error("❌ Error:", e);
    res.sendStatus(500);
  }
});

// =======================
// 🔥 FUNCIONES DE PAGO Y CONFIRMACIÓN
// =======================
const calcularTotal = (s) => {
  let total = 0;
  s.pizzas.forEach(p => {
    total += PRICES[p.type][p.size];
    if (p.crust) total += PRICES.orilla_queso;
    total += p.extras.length * PRICES.extra;
  });
  if (s.delivery) total += PRICES.envio;
  return total;
};

const paymentOptions = () => buttons("💰 *MÉTODO DE PAGO*", [
  { id: "pago_efectivo", title: "💵 Efectivo" },
  { id: "pago_transferencia", title: "🏦 Transferencia" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const paymentForzadoMessage = (total) => buttons(
  `⚠️ *PEDIDO SUPERIOR A $${UMBRAL_TRANSFERENCIA}* ⚠️\n\n💰 Total: $${total}\n\nSolo aceptamos *TRANSFERENCIA*`,
  [
    { id: "pago_transferencia", title: "🏦 Transferencia" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const locationOrAddress = () => buttons("📍 *¿CÓMO QUIERES DAR TU UBICACIÓN?*", [
  { id: "ubicacion", title: "📍 Compartir ubicación" },
  { id: "direccion", title: "📝 Escribir dirección" },
  { id: "cancelar", title: "❌ Cancelar" }
]);

const confirmacionFinal = (s) => {
  const total = calcularTotal(s);
  let resumen = "📋 *CONFIRMA TU PEDIDO*\n\n";
  resumen += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  
  s.pizzas.forEach((p, i) => {
    resumen += `🍕 *PIZZA ${i+1}*\n`;
    resumen += `   • ${p.type.replace("_", " ")}\n`;
    resumen += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    if (p.crust) resumen += `   • 🧀 Orilla de queso\n`;
    if (p.extras?.length) {
      resumen += `   • ➕ Extras: ${p.extras.join(", ")}\n`;
    }
  });
  
  resumen += "\n━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  resumen += `💰 *TOTAL: $${total}*\n`;
  resumen += `💳 *PAGO: ${s.pagoMetodo}*\n`;
  resumen += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  resumen += "¿Todo correcto?";
  
  return buttons(resumen, [
    { id: "confirmar", title: "✅ Confirmar pedido" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const finalizarPedido = async (s, from) => {
  const total = calcularTotal(s);
  const resumenCliente = buildSummary(s);
  const resumenNegocio = buildBusinessSummary(s);
  
  await sendMessage(from, resumenCliente);
  await sendMessage(BUSINESS_NUMBER, resumenNegocio);
  
  if (s.pagoMetodo === "Transferencia") {
    await sendMessage(from, textMsg(
      "✅ *PEDIDO CONFIRMADO*\n\n" +
      "Tu pago está siendo verificado.\n" +
      "Te confirmaremos por este medio."
    ));
  }
  
  delete sessions[from];
};

// =======================
// FUNCIÓN PARA RESUMEN DEL NEGOCIO
// =======================
const buildBusinessSummary = (s) => {
  let total = 0;
  let text = "🛎️ *NUEVO PEDIDO* 🛎️\n\n";
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  
  text += `👤 *CLIENTE*: ${s.clientNumber}\n\n`;

  s.pizzas.forEach((p, i) => {
    const pizzaPrice = PRICES[p.type][p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   • ${p.type.replace("_", " ")}\n`;
    text += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   • Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `   • 🧀 Orilla de queso: +$${PRICES.orilla_queso}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `   • ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *ENTREGA*: A domicilio\n`;
    text += `   • Envío: +$${PRICES.envio}\n`;
    text += `   • 📍 ${s.address || "Compartió ubicación"}\n`;
    text += `   • 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += `💳 *PAGO*: ${s.pagoMetodo || "No especificado"}\n`;
  if (s.pagoMetodo === "Transferencia") {
    text += `   • 🏦 Comprobante: ${s.comprobanteEnviado ? "✅ Recibido" : "⏳ Pendiente"}\n`;
  }
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += `🕒 *HORA*: ${new Date().toLocaleString('es-MX')}\n`;
  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += "✨ *Prepáralo con amor* ✨";

  return { type: "text", text: { body: text } };
};

// =======================
// UI
// =======================
const welcomeMessage = () => buttons(
  "🍕 *BIENVENIDO A PIZZERÍA VILLA* 🍕\n\n¡La mejor pizza de la colonia!\n\n¿Qué deseas hacer hoy?",
  [
    { id: "pedido", title: "🛒 Hacer pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const menuText = () => textMsg(
  "📖 *MENÚ*\n\n" +
  "🍕 Pepperoni: $130 / $180\n" +
  "🍕 Carnes frías: $170 / $220\n" +
  "🍕 Hawaiana: $150 / $210\n" +
  "🍕 Mexicana: $200 / $250\n\n" +
  "🧀 Orilla de queso: +$40\n" +
  "➕ Extras: $15 c/u\n" +
  "🚚 Envío: $40\n\n" +
  "🕒 *Horario:* 11am - 9pm\n" +
  "❌ *Martes cerrado*"
);

const pizzaList = () => list("🍕 *ELIGE TU PIZZA*", [{
  title: "PIZZAS",
  rows: Object.keys(PRICES)
    .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
    .map(p => ({
      id: p,
      title: `🍕 ${p.replace("_", " ")}`,
      description: `G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
    }))
}]);

const sizeButtons = (pizzaType) => {
  const prices = PRICES[pizzaType];
  return buttons("📏 *TAMAÑO*", [
    { id: "grande", title: `Grande $${prices.grande}` },
    { id: "extragrande", title: `Extra $${prices.extragrande}` },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const askCrust = () => buttons("🧀 *¿ORILLA DE QUESO?* (+$40)", [
  { id: "crust_si", title: "✅ Sí (+$40)" },
  { id: "crust_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const askExtra = () => buttons("➕ *¿AGREGAR EXTRA?* ($15 c/u)", [
  { id: "extra_si", title: "✅ Sí" },
  { id: "extra_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const extrasAllowed = () =>
  ["pepperoni", "jamon", "jalapeno", "pina", "chorizo", "queso"];

const extraList = () => list("➕ *ELIGE UN EXTRA* ($15)", [{
  title: "EXTRAS",
  rows: extrasAllowed().map(e => ({
    id: e,
    title: `• ${e.charAt(0).toUpperCase() + e.slice(1)}`,
    description: "+$15"
  }))
}]);

const askMoreExtras = () => buttons("➕ *¿OTRO EXTRA?*", [
  { id: "extra_si", title: "✅ Sí" },
  { id: "extra_no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const anotherPizza = () => buttons("🍕 *¿OTRA PIZZA?*", [
  { id: "si", title: "✅ Sí" },
  { id: "no", title: "❌ No" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const deliveryButtons = () => buttons("🚚 *MÉTODO DE ENTREGA*", [
  { id: "domicilio", title: "🏠 A domicilio (+$40)" },
  { id: "recoger", title: "🏪 Recoger en tienda" },
  { id: "cancelar", title: "⏹️ Cancelar" }
]);

const stepUI = (s) => {
  switch (s.step) {
    case "welcome": return welcomeMessage();
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s.currentPizza?.type);
    case "ask_cheese_crust": return askCrust();
    case "ask_extra": return askExtra();
    case "choose_extra": return extraList();
    case "more_extras": return askMoreExtras();
    case "another_pizza": return anotherPizza();
    case "delivery_method": return deliveryButtons();
    case "ask_payment": return s.pagoForzado ? paymentForzadoMessage(s.totalTemp) : paymentOptions();
    case "ask_location_or_address": return locationOrAddress();
    default: return welcomeMessage();
  }
};

// =======================
// HELPERS
// =======================
const textMsg = body => ({ type: "text", text: { body } });
const merge = (a, b) => [a, b];

const buttons = (text, options) => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text },
    action: {
      buttons: options.map(o => ({
        type: "reply",
        reply: { id: o.id, title: o.title.substring(0, 20) }
      }))
    }
  }
});

const list = (text, sections) => ({
  type: "interactive",
  interactive: {
    type: "list",
    body: { text },
    action: {
      button: "📋 Ver opciones",
      sections
    }
  }
});

const buildSummary = (s) => {
  let total = 0;
  let text = "✅ *¡PEDIDO CONFIRMADO!* ✅\n\n";
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";

  s.pizzas.forEach((p, i) => {
    const pizzaPrice = PRICES[p.type][p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   • ${p.type.replace("_", " ")}\n`;
    text += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   • Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso;
      text += `   • 🧀 Orilla de queso: +$${PRICES.orilla_queso}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra;
      total += extrasTotal;
      text += `   • ➕ Extras: ${p.extras.map(e => 
        e.charAt(0).toUpperCase() + e.slice(1)
      ).join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *ENTREGA*: A domicilio\n`;
    text += `   • Envío: +$${PRICES.envio}\n`;
    text += `   • 📍 ${s.address || "Ubicación compartida"}\n`;
    text += `   • 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += "✨ *¡Gracias por tu pedido!*\n";
  text += "🍕 *Pizzería Villa*";

  return textMsg(text);
};

async function sendMessage(to, payload) {
  try {
    const msgs = Array.isArray(payload) ? payload : [payload];
    for (const m of msgs) {
      await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          ...m
        })
      });
    }
  } catch (error) {
    console.error("❌ Error sendMessage:", error);
  }
}

// =======================
// LIMPIEZA
// =======================
setInterval(() => {
  const nowTime = now();
  Object.keys(sessions).forEach(key => {
    if (nowTime - sessions[key].lastAction > SESSION_TIMEOUT) {
      delete sessions[key];
      console.log(`🧹 Sesión expirada: ${key}`);
    }
  });
}, 60000);

// =======================
// START
// =======================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Bot corriendo en puerto ${PORT}`);
  console.log(`📱 Número pizzería: ${BUSINESS_NUMBER}`);
  console.log(`🕒 Horario: 11am-9pm (Martes CERRADO)`);
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
});