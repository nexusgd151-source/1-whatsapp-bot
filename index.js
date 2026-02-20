const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// 🏪 CONFIGURACIÓN DE SUCURSALES
// =======================
const SUCURSALES = {
  revolucion: {
    nombre: "VILLA REVOLUCIÓN",
    telefono: "5216391759607", // 🔥 Número de Revolución
    domicilio: false, // ❌ No tiene servicio a domicilio
    mercadoPago: {
      cuenta: "722969010279408583",
      beneficiario: "Gabriel Jair Serrato Betance"
    }
  },
  obrera: {
    nombre: "VILLA LA OBRERA",
    telefono: "5216391307561", // 🔥 Número de La Obrera
    domicilio: true, // ✅ Sí tiene servicio a domicilio
    mercadoPago: {
      cuenta: "722969010279408583", // Misma cuenta (o cámbiala si es diferente)
      beneficiario: "Gabriel Jair Serrato Betance"
    }
  }
};

const SESSION_TIMEOUT = 5 * 60 * 1000;
const UMBRAL_TRANSFERENCIA = 450;

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
    step: "seleccionar_sucursal", // 🔥 EMPIEZA AQUÍ
    sucursal: null,
    pizzas: [],
    currentPizza: { extras: [], crust: false },
    lastAction: now(),
    lastInput: null,
    clientNumber: from,
    pendingConfirmation: false,
    pagoForzado: false,
    totalTemp: 0,
    comprobanteEnviado: false,
    pagoMetodo: null,
    delivery: null,
    address: null,
    phone: null,
    pickupName: null
  };
};

const isExpired = (s) => now() - s.lastAction > SESSION_TIMEOUT;
const TEXT_ONLY_STEPS = ["ask_address", "ask_phone", "ask_pickup_name", "ask_comprobante"];

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
    await sendMessage(SUCURSALES.revolucion.telefono, { 
      type: "text", 
      text: { body: "🧪 *PRUEBA REVOLUCIÓN*\n\nBot funcionando." } 
    });
    await sendMessage(SUCURSALES.obrera.telefono, { 
      type: "text", 
      text: { body: "🧪 *PRUEBA OBRERA*\n\nBot funcionando." } 
    });
    res.send("✅ Mensajes enviados a ambas sucursales");
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
    
    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return res.sendStatus(200);

    const msg = value.messages[0];
    const from = msg.from;

    // 🔥 DETECTAR SI ES IMAGEN (COMPROBANTE)
    if (msg.type === "image") {
      console.log(`📸 Cliente ${from} envió comprobante`);
      
      if (!sessions[from]) {
        await sendMessage(from, textMsg("❌ No tienes un pedido pendiente."));
        return res.sendStatus(200);
      }
      
      const s = sessions[from];
      if (!s.sucursal) {
        await sendMessage(from, textMsg("❌ Error: Selecciona una sucursal primero."));
        return res.sendStatus(200);
      }
      
      const sucursal = SUCURSALES[s.sucursal];
      
      await sendMessage(from, textMsg("✅ *COMPROBANTE RECIBIDO*\n\nTu pago está siendo verificado. Te confirmaremos en unos minutos."));
      
      // Enviar imagen a la sucursal correspondiente
      await sendMessage(sucursal.telefono, {
        type: "image",
        image: { id: msg.image.id },
        caption: `📎 *COMPROBANTE DE PAGO*\n\n🏪 *${sucursal.nombre}*\n👤 *Cliente:* ${from}\n💰 *Monto:* $${s.totalTemp}\n🕒 *Hora:* ${new Date().toLocaleString('es-MX')}\n\n✅ *Esperando confirmación*`
      });
      
      // Botones para la sucursal
      await sendMessage(sucursal.telefono, {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: `¿Confirmar pago de ${from} por $${s.totalTemp}?` },
          action: {
            buttons: [
              { type: "reply", reply: { id: `pago_ok_${from}_${s.sucursal}`, title: "✅ Sí, pagó" } },
              { type: "reply", reply: { id: `pago_no_${from}_${s.sucursal}`, title: "❌ No, rechazar" } }
            ]
          }
        }
      });
      
      s.comprobanteEnviado = true;
      s.step = "esperando_confirmacion";
      
      return res.sendStatus(200);
    }
    
    // 🔥 DETECTAR RESPUESTA DE LA SUCURSAL
    if (msg.type === "interactive" && msg.interactive?.button_reply) {
      const replyId = msg.interactive.button_reply.id;
      
      if (replyId.startsWith("pago_ok_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const sucursal = SUCURSALES[sucursalKey];
        
        await sendMessage(cliente, textMsg(
          "✅ *PAGO CONFIRMADO*\n\n" +
          `Tu transferencia ha sido verificada en ${sucursal.nombre}.\n` +
          "¡Tu pedido ya está en preparación! 🍕"
        ));
        await sendMessage(sucursal.telefono, textMsg(`✅ Pago confirmado para cliente ${cliente}`));
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("pago_no_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const sucursal = SUCURSALES[sucursalKey];
        
        await sendMessage(cliente, textMsg(
          "❌ *PAGO RECHAZADO*\n\n" +
          "No pudimos verificar tu transferencia.\n" +
          `Contacta a ${sucursal.nombre} para más información.`
        ));
        await sendMessage(sucursal.telefono, textMsg(`❌ Pago rechazado para cliente ${cliente}`));
        return res.sendStatus(200);
      }
    }

    const rawText = msg.text?.body;
    let input =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id;

    if (input) input = normalize(input);

    if (!sessions[from] || isExpired(sessions[from])) {
      resetSession(from);
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    const s = sessions[from];
    s.lastAction = now();

    // ===== ANTI-SPAM NIVEL DIOS =====
    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      console.log(`🛑 Anti-spam: input repetido de ${from}`);
      return res.sendStatus(200);
    }
    s.lastInput = input;

    // ===== VALIDACIÓN ESTRICTA =====
    if (!s.sucursal && s.step !== "seleccionar_sucursal") {
      resetSession(from);
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado.\n\n¡Esperamos verte pronto! 🍕"));
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, textMsg(`⚠️ Usa los botones.`));
      const botones = stepUI(s);
      if (botones) await sendMessage(from, botones);
      return res.sendStatus(200);
    }

    let reply = null;

    // 🔥 FLUJO PRINCIPAL
    switch (s.step) {

      // ===== SELECCIÓN DE SUCURSAL =====
      case "seleccionar_sucursal":
        if (input === "revolucion") {
          s.sucursal = "revolucion";
          s.step = "welcome";
          reply = welcomeMessage(s);
        } else if (input === "obrera") {
          s.sucursal = "obrera";
          s.step = "welcome";
          reply = welcomeMessage(s);
        } else {
          reply = merge(textMsg("❌ Selecciona una sucursal"), seleccionarSucursal());
        }
        break;

      // ===== BIENVENIDA CON NOMBRE DE SUCURSAL =====
      case "welcome":
        if (input === "pedido") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "menu") {
          reply = merge(menuText(), welcomeMessage(s));
        } else {
          reply = merge(textMsg("❌ Opción no válida"), welcomeMessage(s));
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
          reply = deliveryButtons(s);
        } else {
          reply = merge(textMsg("❌ Opción no válida"), anotherPizza());
        }
        break;

      case "delivery_method":
        const sucursal = SUCURSALES[s.sucursal];
        
        if (!sucursal.domicilio) {
          // 🔥 Sucursal sin domicilio
          if (input === "recoger") {
            s.delivery = false;
            s.totalTemp = calcularTotal(s);
            s.step = "ask_payment";
            reply = paymentOptions(s);
          } else if (input === "domicilio") {
            reply = merge(
              textMsg("🚫 *SERVICIO A DOMICILIO NO DISPONIBLE*\n\nPor el momento solo atendemos en local."),
              deliveryButtons(s)
            );
          } else {
            reply = merge(textMsg("❌ Opción no válida"), deliveryButtons(s));
          }
        } else {
          // 🔥 Sucursal CON domicilio
          if (input === "domicilio") {
            s.delivery = true;
            s.totalTemp = calcularTotal(s);
            
            if (s.totalTemp >= UMBRAL_TRANSFERENCIA) {
              s.pagoForzado = true;
              s.step = "ask_payment";
              reply = paymentForzadoMessage(s);
            } else {
              s.step = "ask_payment";
              reply = paymentOptions(s);
            }
          } else if (input === "recoger") {
            s.delivery = false;
            s.totalTemp = calcularTotal(s);
            s.step = "ask_payment";
            reply = paymentOptions(s);
          } else {
            reply = merge(textMsg("❌ Opción no válida"), deliveryButtons(s));
          }
        }
        break;

      case "ask_payment":
        const sucursalPago = SUCURSALES[s.sucursal];
        
        if (s.pagoForzado) {
          if (input !== "pago_transferencia") {
            reply = merge(
              textMsg(`❌ Pedidos > $${UMBRAL_TRANSFERENCIA} solo transferencia`),
              paymentForzadoMessage(s)
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
            reply = merge(textMsg("❌ Selecciona método"), paymentOptions(s));
            break;
          }
        }
        
        if (s.delivery) {
          s.step = "ask_address";
          reply = textMsg("📍 *DIRECCIÓN*\n\nEscribe tu dirección completa:");
        } else {
          s.step = "ask_pickup_name";
          reply = textMsg("🏪 *RECOGER*\n\nEscribe el nombre de quien recoge:");
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
        s.step = "confirmacion_final";
        reply = confirmacionFinal(s);
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg("⚠️ Nombre inválido. Intenta de nuevo:");
          break;
        }
        s.pickupName = rawText;
        s.step = "confirmacion_final";
        reply = confirmacionFinal(s);
        break;

      case "confirmacion_final":
        if (input === "confirmar") {
          if (s.pagoMetodo === "Transferencia") {
            s.step = "ask_comprobante";
            reply = textMsg(
              "🧾 *COMPROBANTE DE PAGO*\n\n" +
              "📲 *Datos para transferencia (Mercado Pago):*\n" +
              `🏦 Cuenta: ${SUCURSALES[s.sucursal].mercadoPago.cuenta}\n` +
              `👤 Beneficiario: ${SUCURSALES[s.sucursal].mercadoPago.beneficiario}\n` +
              "💰 Monto: $" + s.totalTemp + "\n\n" +
              "✅ *Envía la FOTO del comprobante* para confirmar tu pedido."
            );
          } else {
            await finalizarPedido(s, from);
            reply = null;
          }
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(textMsg("❌ Pedido cancelado."), seleccionarSucursal());
        } else {
          reply = merge(textMsg("❌ Opción no válida"), confirmacionFinal(s));
        }
        break;

      case "ask_comprobante":
        reply = textMsg("📸 *ENVÍA LA FOTO DEL COMPROBANTE*\n\nPresiona el clip 📎 y selecciona la imagen.");
        break;

      case "esperando_confirmacion":
        reply = textMsg("⏳ *PAGO EN VERIFICACIÓN*\n\nYa recibimos tu comprobante. Te confirmaremos en unos minutos.");
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
// 🔥 FUNCIONES CON SUCURSAL
// =======================
const seleccionarSucursal = () => buttons(
  "🏪 *BIENVENIDO A PIZZERÍAS VILLA* 🏪\n\n¿En qué sucursal quieres pedir?",
  [
    { id: "revolucion", title: "🌋 Villa Revolución" },
    { id: "obrera", title: "🏭 Villa La Obrera" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]
);

const welcomeMessage = (s) => {
  const sucursal = SUCURSALES[s.sucursal];
  return buttons(
    `🍕 *BIENVENIDO A ${sucursal.nombre}* 🍕\n\n¡La mejor pizza de la colonia!\n\n¿Qué deseas hacer hoy?`,
    [
      { id: "pedido", title: "🛒 Hacer pedido" },
      { id: "menu", title: "📖 Ver menú" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const deliveryButtons = (s) => {
  const sucursal = SUCURSALES[s.sucursal];
  const opciones = [];
  
  if (sucursal.domicilio) {
    opciones.push({ id: "domicilio", title: "🏠 A domicilio (+$40)" });
  }
  opciones.push({ id: "recoger", title: "🏪 Recoger en tienda" });
  opciones.push({ id: "cancelar", title: "❌ Cancelar" });
  
  return buttons("🚚 *MÉTODO DE ENTREGA*", opciones);
};

const paymentOptions = (s) => {
  const opciones = [
    { id: "pago_efectivo", title: "💵 Efectivo" }
  ];
  
  // Siempre mostrar transferencia como opción
  opciones.push({ id: "pago_transferencia", title: "🏦 Mercado Pago" });
  opciones.push({ id: "cancelar", title: "❌ Cancelar" });
  
  return buttons("💰 *MÉTODO DE PAGO*", opciones);
};

const paymentForzadoMessage = (s) => {
  return buttons(
    `⚠️ *PEDIDO SUPERIOR A $${UMBRAL_TRANSFERENCIA}* ⚠️\n\n💰 Total: $${s.totalTemp}\n\nSolo aceptamos *MERCADO PAGO*`,
    [
      { id: "pago_transferencia", title: "🏦 Mercado Pago" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

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

const confirmacionFinal = (s) => {
  const total = calcularTotal(s);
  const sucursal = SUCURSALES[s.sucursal];
  
  let resumen = `📋 *CONFIRMA TU PEDIDO - ${sucursal.nombre}*\n\n`;
  resumen += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  
  s.pizzas.forEach((p, i) => {
    resumen += `🍕 *PIZZA ${i+1}*\n`;
    resumen += `   • ${p.type.replace("_", " ")}\n`;
    resumen += `   • ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    if (p.crust) resumen += `   • 🧀 Orilla de queso\n`;
    if (p.extras?.length) {
      resumen += `   • ➕ Extras: ${p.extras.join(", ")}\n`;
    }
    resumen += "\n";
  });
  
  resumen += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  resumen += `💰 *TOTAL: $${total}*\n`;
  resumen += `💳 *PAGO: ${s.pagoMetodo === "Transferencia" ? "Mercado Pago" : "Efectivo"}*\n`;
  resumen += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  resumen += "¿Todo correcto?";
  
  return buttons(resumen, [
    { id: "confirmar", title: "✅ Confirmar pedido" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const finalizarPedido = async (s, from) => {
  const sucursal = SUCURSALES[s.sucursal];
  const resumenCliente = buildSummary(s);
  const resumenNegocio = buildBusinessSummary(s);
  
  await sendMessage(from, resumenCliente);
  await sendMessage(sucursal.telefono, resumenNegocio);
  
  if (s.pagoMetodo === "Efectivo") {
    await sendMessage(sucursal.telefono, 
      textMsg(`💵 *PAGO EN EFECTIVO*\n\nCliente: ${from}\nTotal: $${s.totalTemp}`)
    );
  }
  
  delete sessions[from];
};

// =======================
// RESUMENES
// =======================
const buildBusinessSummary = (s) => {
  const sucursal = SUCURSALES[s.sucursal];
  let total = 0;
  let text = `🛎️ *NUEVO PEDIDO - ${sucursal.nombre}* 🛎️\n\n`;
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
    text += `   • 📍 ${s.address}\n`;
    text += `   • 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += `💳 *PAGO*: ${s.pagoMetodo === "Transferencia" ? "Mercado Pago" : "Efectivo"}\n`;
  if (s.pagoMetodo === "Transferencia") {
    text += `   • 🏦 Comprobante: ${s.comprobanteEnviado ? "✅ Recibido" : "⏳ Pendiente"}\n`;
  }
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += `🕒 *HORA*: ${new Date().toLocaleString('es-MX')}\n`;
  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += "✨ *Prepáralo con amor* ✨";

  return { type: "text", text: { body: text } };
};

const buildSummary = (s) => {
  const sucursal = SUCURSALES[s.sucursal];
  let total = 0;
  let text = `✅ *¡PEDIDO CONFIRMADO - ${sucursal.nombre}!* ✅\n\n`;
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
      text += `   • ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";

  if (s.delivery) {
    total += PRICES.envio;
    text += `🚚 *ENTREGA*: A domicilio\n`;
    text += `   • Envío: +$${PRICES.envio}\n`;
    text += `   • 📍 ${s.address}\n`;
    text += `   • 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA*: Recoger en tienda\n`;
    text += `   • 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n";
  text += `✨ *¡Gracias por tu pedido en ${sucursal.nombre}!*\n`;
  text += "🍕 *Pizzerías Villa*";

  return textMsg(text);
};

// =======================
// UI BASE
// =======================
const menuText = () => textMsg(
  "📖 *MENÚ*\n\n" +
  "🍕 Pepperoni: $130 / $180\n" +
  "🍕 Carnes frías: $170 / $220\n" +
  "🍕 Hawaiana: $150 / $210\n" +
  "🍕 Mexicana: $200 / $250\n\n" +
  "🧀 Orilla de queso: +$40\n" +
  "➕ Extras: $15 c/u\n" +
  "🚚 Envío: $40"
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

const stepUI = (s) => {
  if (!s.sucursal) return seleccionarSucursal();
  
  switch (s.step) {
    case "welcome": return welcomeMessage(s);
    case "pizza_type": return pizzaList();
    case "size": return sizeButtons(s.currentPizza?.type);
    case "ask_cheese_crust": return askCrust();
    case "ask_extra": return askExtra();
    case "choose_extra": return extraList();
    case "more_extras": return askMoreExtras();
    case "another_pizza": return anotherPizza();
    case "delivery_method": return deliveryButtons(s);
    case "ask_payment": return s.pagoForzado ? paymentForzadoMessage(s) : paymentOptions(s);
    default: return welcomeMessage(s);
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

async function sendMessage(to, payload) {
  try {
    const msgs = Array.isArray(payload) ? payload : [payload];
    for (const m of msgs) {
      console.log(`📤 Enviando a ${to}:`, JSON.stringify(m).substring(0, 200) + "...");
      const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
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
      
      if (!response.ok) {
        const error = await response.json();
        console.error("❌ Error WhatsApp API:", error);
      }
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
  console.log(`🚀 Bot multisucursal corriendo en puerto ${PORT}`);
  console.log(`📱 Revolución: ${SUCURSALES.revolucion.telefono}`);
  console.log(`📱 La Obrera: ${SUCURSALES.obrera.telefono}`);
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
  console.log(`🔗 Test: https://one-whatsapp-bot.onrender.com/test-business`);
});