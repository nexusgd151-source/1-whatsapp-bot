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
    direccion: "Batalla de San Andres y Avenida Acceso Norte 418, Batalla de San Andrés Supermanzana Calla, 33100 Delicias, Chih.",
    emoji: "🌋",
    telefono: "5216391946965",
    domicilio: false,
    horario: "Lun-Dom 11am-9pm (Martes cerrado)",
    mercadoPago: {
      cuenta: "722969010279408583",
      beneficiario: "Gabriel Jair Serrato Betance"
    }
  },
  obrera: {
    nombre: "VILLA LA OBRERA",
    direccion: "Av Solidaridad 11-local 3, Oriente 2, 33029 Delicias, Chih.",
    emoji: "🏭",
    telefono: "5216391759607",
    domicilio: true,
    horario: "Lun-Dom 11am-9pm (Martes cerrado)",
    mercadoPago: {
      cuenta: "722969010279408583",
      beneficiario: "Gabriel Jair Serrato Betance"
    }
  }
};

const SESSION_TIMEOUT = 5 * 60 * 1000;
const UMBRAL_TRANSFERENCIA = 450;

const PRICES = {
  pepperoni: { 
    nombre: "Pepperoni", 
    grande: 130, 
    extragrande: 180,
    emoji: "🍕"
  },
  carnes_frias: { 
    nombre: "Carnes Frías", 
    grande: 170, 
    extragrande: 220,
    emoji: "🥩"
  },
  hawaiana: { 
    nombre: "Hawaiana", 
    grande: 150, 
    extragrande: 210,
    emoji: "🍍"
  },
  mexicana: { 
    nombre: "Mexicana", 
    grande: 200, 
    extragrande: 250,
    emoji: "🌶️"
  },
  orilla_queso: {
    nombre: "Orilla de Queso",
    precio: 40,
    emoji: "🧀"
  },
  extra: {
    nombre: "Extra",
    precio: 15,
    emoji: "➕"
  },
  envio: {
    nombre: "Envío a domicilio",
    precio: 40,
    emoji: "🚚"
  }
};

const EXTRAS = {
  pepperoni: { nombre: "Pepperoni extra", emoji: "🍖" },
  jamon: { nombre: "Jamón extra", emoji: "🥓" },
  jalapeno: { nombre: "Jalapeño", emoji: "🌶️" },
  pina: { nombre: "Piña", emoji: "🍍" },
  chorizo: { nombre: "Chorizo", emoji: "🌭" },
  queso: { nombre: "Queso extra", emoji: "🧀" }
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
    step: "seleccionar_sucursal",
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
    pickupName: null,
    pagoProcesado: false,
    pagosProcesados: {}
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
      text: { body: "🧪 *PRUEBA REVOLUCIÓN*\n\nBot funcionando correctamente." } 
    });
    await sendMessage(SUCURSALES.obrera.telefono, { 
      type: "text", 
      text: { body: "🧪 *PRUEBA OBRERA*\n\nBot funcionando correctamente." } 
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

    // 🔥 DETECTAR IMAGEN (COMPROBANTE)
    if (msg.type === "image" || msg.type === "document") {
      console.log(`📸 Cliente ${from} envió ${msg.type === "image" ? "imagen" : "documento"}`);
      
      if (!sessions[from]) {
        await sendMessage(from, textMsg("❌ *ERROR*\n\nNo tienes un pedido pendiente."));
        return res.sendStatus(200);
      }
      
      const s = sessions[from];
      if (!s.sucursal) {
        await sendMessage(from, textMsg("❌ *ERROR*\n\nSelecciona una sucursal primero."));
        return res.sendStatus(200);
      }
      
      const sucursal = SUCURSALES[s.sucursal];
      
      if (s.step !== "ask_comprobante" && s.step !== "esperando_confirmacion") {
        await sendMessage(from, textMsg("❌ *ERROR*\n\nNo estamos esperando un comprobante en este momento."));
        return res.sendStatus(200);
      }
      
      if (s.pagoProcesado) {
        await sendMessage(from, textMsg("❌ *ERROR*\n\nEste pago ya fue procesado anteriormente."));
        return res.sendStatus(200);
      }
      
      await sendMessage(from, textMsg(
        "✅ *COMPROBANTE RECIBIDO*\n\n" +
        "📸 Hemos recibido tu comprobante de pago.\n" +
        "⏳ Lo estamos verificando...\n\n" +
        "Te confirmaremos en unos minutos. ¡Gracias! 🙌"
      ));
      
      let mediaPayload;
      let mediaType = "image";
      
      if (msg.type === "image") {
        mediaPayload = { id: msg.image.id };
        console.log(`🖼️ ID de imagen: ${msg.image.id}`);
      } else if (msg.type === "document") {
        if (msg.document.mime_type?.startsWith("image/")) {
          mediaPayload = { id: msg.document.id };
          console.log(`📄 Documento de imagen recibido, ID: ${msg.document.id}, MIME: ${msg.document.mime_type}`);
        } else {
          await sendMessage(from, textMsg("❌ *ERROR*\n\nEl archivo no es una imagen. Por favor envía una foto."));
          return res.sendStatus(200);
        }
      }
      
      const pagoId = `${from}_${s.sucursal}_${Date.now()}`;
      s.pagoId = pagoId;
      
      const caption = 
        "📎 *NUEVO COMPROBANTE DE PAGO*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
        `🏪 *SUCURSAL:* ${sucursal.emoji} ${sucursal.nombre}\n` +
        `👤 *CLIENTE:* ${from}\n` +
        `💰 *MONTO:* $${s.totalTemp} MXN\n` +
        `🕒 *HORA:* ${new Date().toLocaleString('es-MX')}\n\n` +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "👇 *VERIFICAR PAGO* 👇";
      
      await sendMessage(sucursal.telefono, {
        type: mediaType,
        [mediaType]: mediaPayload,
        caption: caption
      });
      
      await sendMessage(sucursal.telefono, {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: `🔍 *VERIFICAR PAGO - $${s.totalTemp}*` },
          action: {
            buttons: [
              { 
                type: "reply", 
                reply: { 
                  id: `pago_ok_${pagoId}`, 
                  title: "✅ CONFIRMAR PAGO" 
                } 
              },
              { 
                type: "reply", 
                reply: { 
                  id: `pago_no_${pagoId}`, 
                  title: "❌ RECHAZAR PAGO" 
                } 
              }
            ]
          }
        }
      });
      
      console.log(`📤 Botones de verificación enviados a sucursal ${sucursal.telefono} con ID ${pagoId}`);
      
      s.comprobanteEnviado = true;
      s.step = "esperando_confirmacion";
      
      return res.sendStatus(200);
    }
    
    // 🔥 DETECTAR RESPUESTA DE SUCURSAL - VERSIÓN CORREGIDA (LÍNEA ~261)
    if (msg.type === "interactive" && msg.interactive?.button_reply) {
      const replyId = msg.interactive.button_reply.id;
      console.log(`🔍 Botón presionado: ${replyId}`);
      console.log(`📦 Mensaje completo:`, JSON.stringify(msg, null, 2));
      
      // VERIFICAR SI ES UN BOTÓN DE PAGO
      if (replyId.startsWith("pago_ok_") || replyId.startsWith("pago_no_")) {
        console.log(`✅ Detectado botón de pago: ${replyId}`);
        
        // Extraer información del ID (formato: pago_ok_cliente_sucursal_timestamp)
        const partes = replyId.split("_");
        const tipo = partes[1]; // "ok" o "no"
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const timestamp = partes[4];
        
        console.log(`📊 Datos extraídos: tipo=${tipo}, cliente=${cliente}, sucursal=${sucursalKey}, timestamp=${timestamp}`);
        
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal) {
          console.log(`❌ Sucursal no encontrada: ${sucursalKey}`);
          await sendMessage(from, textMsg("❌ *ERROR*\n\nSucursal no identificada."));
          return res.sendStatus(200);
        }
        
        // Verificar que el cliente existe
        if (!sessions[cliente]) {
          console.log(`⚠️ Cliente ${cliente} no tiene sesión activa`);
          await sendMessage(sucursal.telefono, 
            textMsg("⚠️ *ERROR*\n\nEl cliente ya no tiene una sesión activa.")
          );
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        
        // Verificar que el ID del pago coincide
        if (s.pagoId !== `${cliente}_${sucursalKey}_${timestamp}`) {
          console.log(`⚠️ ID de pago no coincide. Esperado: ${s.pagoId}, Recibido: ${cliente}_${sucursalKey}_${timestamp}`);
          await sendMessage(sucursal.telefono, 
            textMsg("⚠️ *ERROR*\n\nEste botón ya no es válido. El pago fue procesado con otro ID.")
          );
          return res.sendStatus(200);
        }
        
        // Verificar que el pago no fue procesado
        if (s.pagoProcesado) {
          console.log(`🛑 Pago ya procesado para cliente ${cliente}`);
          await sendMessage(sucursal.telefono, 
            textMsg("⚠️ *PAGO YA PROCESADO*\n\nEste pago ya fue confirmado/rechazado anteriormente.")
          );
          return res.sendStatus(200);
        }
        
        // Verificar que hay un monto válido
        if (!s.totalTemp || s.totalTemp <= 0) {
          console.log(`⚠️ Monto inválido para cliente ${cliente}: ${s.totalTemp}`);
          await sendMessage(sucursal.telefono, 
            textMsg("⚠️ *ERROR*\n\nNo hay información de monto válida para este pedido.")
          );
          return res.sendStatus(200);
        }
        
        // Marcar como procesado
        s.pagoProcesado = true;
        
        if (tipo === "ok") {
          console.log(`✅ Confirmando pago para cliente ${cliente} por $${s.totalTemp}`);
          
          // Notificar al cliente
          await sendMessage(cliente, textMsg(
            "✅ *¡PAGO CONFIRMADO!* ✅\n\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
            `🏪 *${sucursal.emoji} ${sucursal.nombre}*\n\n` +
            "Tu transferencia ha sido verificada correctamente.\n" +
            "¡Tu pedido ya está en preparación! 🍕\n\n" +
            "⏱️ *Tiempo estimado:* 30-40 minutos\n\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n" +
            "¡Gracias por tu preferencia! 🙌"
          ));
          
          // Notificar a la sucursal
          await sendMessage(sucursal.telefono, 
            textMsg(
              "━━━━━━━━━━━━━━━━━━━━━━\n" +
              "✅ *PAGO CONFIRMADO* ✅\n" +
              "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
              `👤 *Cliente:* ${cliente}\n` +
              `💰 *Monto:* $${s.totalTemp} MXN\n` +
              `🕒 *Hora:* ${new Date().toLocaleString('es-MX')}\n\n` +
              "El pedido ya puede prepararse.\n" +
              "━━━━━━━━━━━━━━━━━━━━━━"
            )
          );
          
          console.log(`✅ Notificaciones enviadas para pago confirmado`);
          
        } else if (tipo === "no") {
          console.log(`❌ Rechazando pago para cliente ${cliente}`);
          
          // Notificar al cliente
          await sendMessage(cliente, textMsg(
            "❌ *PAGO RECHAZADO* ❌\n\n" +
            "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
            `🏪 *${sucursal.emoji} ${sucursal.nombre}*\n\n` +
            "No pudimos verificar tu transferencia.\n\n" +
            "Posibles causas:\n" +
            "• El monto no coincide\n" +
            "• La referencia es incorrecta\n" +
            "• La imagen no es legible\n\n" +
            "📞 *Contacta a la sucursal para asistencia:*\n" +
            `${sucursal.telefono}\n\n` +
            "━━━━━━━━━━━━━━━━━━━━━━"
          ));
          
          // Notificar a la sucursal
          await sendMessage(sucursal.telefono, 
            textMsg(
              "━━━━━━━━━━━━━━━━━━━━━━\n" +
              "❌ *PAGO RECHAZADO* ❌\n" +
              "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
              `👤 *Cliente:* ${cliente}\n` +
              `💰 *Monto:* $${s.totalTemp} MXN\n` +
              `🕒 *Hora:* ${new Date().toLocaleString('es-MX')}\n\n` +
              "El pedido NO será preparado.\n" +
              "━━━━━━━━━━━━━━━━━━━━━━"
            )
          );
          
          console.log(`✅ Notificaciones enviadas para pago rechazado`);
        }
        
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

    // ===== ANTI-SPAM =====
    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      console.log(`🛑 Anti-spam: input repetido de ${from}`);
      return res.sendStatus(200);
    }
    s.lastInput = input;

    // ===== VALIDACIÓN =====
    if (!s.sucursal && s.step !== "seleccionar_sucursal") {
      resetSession(from);
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg(
        "❌ *PEDIDO CANCELADO* ❌\n\n" +
        "Tu pedido ha sido cancelado.\n" +
        "¡Esperamos verte pronto! 🍕"
      ));
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, textMsg(
        "⚠️ *SOLO BOTONES* ⚠️\n\n" +
        "Por favor, usa los botones para continuar."
      ));
      const botones = stepUI(s);
      if (botones) await sendMessage(from, botones);
      return res.sendStatus(200);
    }

    let reply = null;

    // =======================
    // 🎯 FLUJO PRINCIPAL
    // =======================
    switch (s.step) {

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
          reply = merge(
            textMsg("❌ *OPCIÓN INVÁLIDA*\n\nSelecciona una sucursal:"),
            seleccionarSucursal()
          );
        }
        break;

      case "welcome":
        if (input === "pedido") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "menu") {
          reply = merge(menuText(s), welcomeMessage(s));
        } else {
          reply = merge(
            textMsg("❌ *OPCIÓN INVÁLIDA*"),
            welcomeMessage(s)
          );
        }
        break;

      case "pizza_type":
        if (!PRICES[input]) {
          reply = merge(
            textMsg("❌ *PIZZA NO VÁLIDA*\n\nSelecciona una opción del menú:"),
            pizzaList()
          );
          break;
        }
        console.log(`✅ Pizza elegida: ${input}`);
        s.currentPizza.type = input;
        s.currentPizza.extras = [];
        s.currentPizza.crust = false;
        s.step = "size";
        reply = sizeButtons(s.currentPizza.type);
        break;

      case "size":
        if (!["grande", "extragrande"].includes(input)) {
          console.log(`❌ Tamaño no válido: ${input}`);
          reply = merge(
            textMsg("❌ *TAMAÑO NO VÁLIDO*\n\nSelecciona una opción válida:"),
            sizeButtons(s.currentPizza.type)
          );
          break;
        }
        
        console.log(`✅ Tamaño seleccionado: ${input}`);
        s.currentPizza.size = input;
        s.step = "ask_cheese_crust";
        reply = askCrust();
        break;

      case "ask_cheese_crust":
        if (input === "crust_si") {
          console.log("✅ Con orilla de queso");
          s.currentPizza.crust = true;
          s.step = "ask_extra";
          reply = askExtra();
        } else if (input === "crust_no") {
          console.log("❌ Sin orilla de queso");
          s.currentPizza.crust = false;
          s.step = "ask_extra";
          reply = askExtra();
        } else {
          console.log(`❌ Opción no válida en orilla: ${input}`);
          reply = merge(
            textMsg("❌ *OPCIÓN NO VÁLIDA*"),
            askCrust()
          );
        }
        break;

      case "ask_extra":
        if (input === "extra_si") {
          console.log("➕ Usuario quiere extras");
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          console.log("❌ Usuario no quiere extras");
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          console.log(`❌ Opción no válida en ask_extra: ${input}`);
          reply = merge(
            textMsg("❌ *OPCIÓN NO VÁLIDA*"),
            askExtra()
          );
        }
        break;

      case "choose_extra":
        if (!Object.keys(EXTRAS).includes(input)) {
          reply = merge(
            textMsg("❌ *EXTRA NO VÁLIDO*"),
            extraList()
          );
          break;
        }
        console.log(`✅ Extra elegido: ${input}`);
        s.currentPizza.extras.push(input);
        s.step = "more_extras";
        reply = askMoreExtras();
        break;

      case "more_extras":
        if (input === "extra_si") {
          console.log("➕ Usuario quiere otro extra");
          s.step = "choose_extra";
          reply = extraList();
        } else if (input === "extra_no") {
          console.log("❌ Usuario terminó extras");
          s.pizzas.push({ ...s.currentPizza });
          s.currentPizza = { extras: [], crust: false };
          s.step = "another_pizza";
          reply = anotherPizza();
        } else {
          console.log(`❌ Opción no válida en more_extras: ${input}`);
          reply = merge(
            textMsg("❌ *OPCIÓN NO VÁLIDA*"),
            askMoreExtras()
          );
        }
        break;

      case "another_pizza":
        if (input === "si") {
          console.log("🍕 Usuario quiere otra pizza");
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "no") {
          console.log("✅ Usuario terminó pizzas");
          s.step = "delivery_method";
          reply = deliveryButtons(s);
        } else {
          console.log(`❌ Opción no válida en another_pizza: ${input}`);
          reply = merge(
            textMsg("❌ *OPCIÓN NO VÁLIDA*"),
            anotherPizza()
          );
        }
        break;

      case "delivery_method":
        const sucursal = SUCURSALES[s.sucursal];
        
        if (!sucursal.domicilio) {
          if (input === "recoger") {
            s.delivery = false;
            s.totalTemp = calcularTotal(s);
            s.step = "ask_payment";
            reply = paymentOptions(s);
          } else if (input === "domicilio") {
            reply = merge(
              textMsg(
                "🚫 *SERVICIO A DOMICILIO NO DISPONIBLE*\n\n" +
                `📌 *${sucursal.emoji} ${sucursal.nombre}*\n` +
                `📍 ${sucursal.direccion}\n\n` +
                "Por el momento solo atendemos en local.\n" +
                "¡Visítanos! Te esperamos 🍕"
              ),
              deliveryButtons(s)
            );
          } else {
            reply = merge(
              textMsg("❌ *OPCIÓN NO VÁLIDA*"),
              deliveryButtons(s)
            );
          }
        } else {
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
            reply = merge(
              textMsg("❌ *OPCIÓN NO VÁLIDA*"),
              deliveryButtons(s)
            );
          }
        }
        break;

      case "ask_payment":
        if (s.pagoForzado) {
          if (input !== "pago_transferencia") {
            reply = merge(
              textMsg(`❌ *OPCIÓN NO DISPONIBLE*\n\nEste pedido solo acepta transferencia.`),
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
            reply = merge(
              textMsg("❌ *SELECCIONA UN MÉTODO DE PAGO*"),
              paymentOptions(s)
            );
            break;
          }
        }
        
        if (s.delivery) {
          s.step = "ask_address";
          reply = textMsg(
            "📍 *DIRECCIÓN DE ENTREGA*\n\n" +
            "Escribe tu dirección completa:\n" +
            "Ej: Calle, Número, Colonia, Referencia"
          );
        } else {
          s.step = "ask_pickup_name";
          reply = textMsg(
            "👤 *NOMBRE PARA RECOGER*\n\n" +
            "Escribe el nombre de la persona que recogerá el pedido:"
          );
        }
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg(
            "⚠️ *DIRECCIÓN INVÁLIDA*\n\n" +
            "Escribe una dirección válida (mínimo 5 caracteres):"
          );
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg(
          "📞 *TELÉFONO DE CONTACTO*\n\n" +
          "Escribe tu número a 10 dígitos:\n" +
          "Ej: 6391234567"
        );
        break;

      case "ask_phone":
        if (!rawText || rawText.length < 8) {
          reply = textMsg(
            "⚠️ *TELÉFONO INVÁLIDO*\n\n" +
            "Escribe un número válido a 10 dígitos:"
          );
          break;
        }
        s.phone = rawText;
        s.step = "confirmacion_final";
        reply = confirmacionFinal(s);
        break;

      case "ask_pickup_name":
        if (!rawText || rawText.length < 3) {
          reply = textMsg(
            "⚠️ *NOMBRE INVÁLIDO*\n\n" +
            "Escribe un nombre válido (mínimo 3 caracteres):"
          );
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
              "🧾 *PAGO CON MERCADO PAGO*\n\n" +
              "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n" +
              "📲 *DATOS PARA TRANSFERENCIA:*\n\n" +
              `🏦 *Cuenta Mercado Pago:* ${SUCURSALES[s.sucursal].mercadoPago.cuenta}\n` +
              `👤 *Beneficiario:* ${SUCURSALES[s.sucursal].mercadoPago.beneficiario}\n` +
              `💰 *Monto exacto:* $${s.totalTemp} MXN\n\n` +
              "📝 *Importante:* Envía el comprobante con el monto exacto.\n\n" +
              "━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━ ━\n\n" +
              "✅ *Envía la FOTO del comprobante* para confirmar tu pedido."
            );
          } else {
            await finalizarPedido(s, from);
            reply = null;
          }
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(
            textMsg("❌ *PEDIDO CANCELADO*"),
            seleccionarSucursal()
          );
        } else {
          reply = merge(
            textMsg("❌ *OPCIÓN NO VÁLIDA*"),
            confirmacionFinal(s)
          );
        }
        break;

      case "ask_comprobante":
        reply = textMsg(
          "📸 *ENVÍA TU COMPROBANTE*\n\n" +
          "1️⃣ Presiona el clip 📎\n" +
          "2️⃣ Selecciona 'Imagen'\n" +
          "3️⃣ Elige la foto de tu comprobante\n\n" +
          "✅ Te confirmaremos en minutos."
        );
        break;

      case "esperando_confirmacion":
        reply = textMsg(
          "⏳ *PAGO EN VERIFICACIÓN*\n\n" +
          "Ya recibimos tu comprobante.\n" +
          "Te confirmaremos en unos minutos.\n\n" +
          "¡Gracias por tu paciencia! 🙏"
        );
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
// 🎨 FUNCIONES UI
// =======================

const seleccionarSucursal = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🏪 *PIZZERÍAS VILLA* 🏪\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¡Bienvenido! ¿En qué sucursal\n" +
    "quieres hacer tu pedido?\n\n" +
    "Selecciona una opción:";
  
  return buttons(texto, [
    { id: "revolucion", title: "🌋 Villa Revolución" },
    { id: "obrera", title: "🏭 Villa La Obrera" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const welcomeMessage = (s) => {
  const nombreSucursal = s.sucursal === "revolucion" ? "Revolución" : "Obrera";
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `🍕 *BIENVENIDO A LAS PIZZAS DE VILLA ${nombreSucursal.toUpperCase()}* 🍕\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Qué deseas hacer hoy?";
  
  return buttons(texto, [
    { id: "pedido", title: "🛒 Hacer pedido" },
    { id: "menu", title: "📖 Ver menú" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const menuText = (s) => {
  const suc = SUCURSALES[s.sucursal];
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `📖 *MENÚ - ${suc.nombre}* 📖\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "🍕 *PIZZAS*\n" +
    "▸ Pepperoni: $130 / $180\n" +
    "▸ Carnes frías: $170 / $220\n" +
    "▸ Hawaiana: $150 / $210\n" +
    "▸ Mexicana: $200 / $250\n\n" +
    "🧀 *EXTRAS*\n" +
    "▸ Orilla de queso: +$40\n" +
    "▸ Ingrediente extra: +$15 c/u\n\n" +
    "🚚 *ENVÍO*\n" +
    "▸ A domicilio: +$40\n\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    `📍 *DIRECCIÓN:*\n${suc.direccion}\n\n` +
    `🕒 *HORARIO:* ${suc.horario}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━";
  
  return textMsg(texto);
};

const pizzaList = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🍕 *ELIGE TU PIZZA* 🍕\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Selecciona una opción:";
  
  return list(texto, [{
    title: "PIZZAS DISPONIBLES",
    rows: Object.keys(PRICES)
      .filter(p => !["extra", "envio", "orilla_queso"].includes(p))
      .map(p => ({
        id: p,
        title: `${PRICES[p].emoji} ${PRICES[p].nombre}`,
        description: `G $${PRICES[p].grande} | EG $${PRICES[p].extragrande}`
      }))
  }]);
};

const sizeButtons = (pizzaType) => {
  const pizza = PRICES[pizzaType];
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `📏 *TAMAÑO - ${pizza.emoji} ${pizza.nombre}* 📏\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Elige el tamaño:";
  
  return buttons(texto, [
    { id: "grande", title: `Grande $${pizza.grande}` },
    { id: "extragrande", title: `Extra grande $${pizza.extragrande}` },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const askCrust = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🧀 *ORILLA DE QUESO* 🧀\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Quieres orilla de queso?\n" +
    `💰 *+$${PRICES.orilla_queso.precio}*`;
  
  return buttons(texto, [
    { id: "crust_si", title: "✅ Sí (+$40)" },
    { id: "crust_no", title: "❌ No" },
    { id: "cancelar", title: "⏹️ Cancelar" }
  ]);
};

const askExtra = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "➕ *EXTRAS* ➕\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Quieres agregar ingredientes extra?\n" +
    `💰 *$${PRICES.extra.precio} c/u*`;
  
  return buttons(texto, [
    { id: "extra_si", title: "✅ Sí" },
    { id: "extra_no", title: "❌ No" },
    { id: "cancelar", title: "⏹️ Cancelar" }
  ]);
};

const extraList = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "➕ *ELIGE UN EXTRA* ➕\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    `💰 *$${PRICES.extra.precio} cada uno*\n\n` +
    "Selecciona un ingrediente:";
  
  return list(texto, [{
    title: "EXTRAS DISPONIBLES",
    rows: Object.entries(EXTRAS).map(([id, extra]) => ({
      id: id,
      title: `${extra.emoji} ${extra.nombre}`,
      description: `+$${PRICES.extra.precio}`
    }))
  }]);
};

const askMoreExtras = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "➕ *¿OTRO EXTRA?* ➕\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Quieres agregar otro ingrediente?";
  
  return buttons(texto, [
    { id: "extra_si", title: "✅ Sí" },
    { id: "extra_no", title: "❌ No" },
    { id: "cancelar", title: "⏹️ Cancelar" }
  ]);
};

const anotherPizza = () => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🍕 *¿OTRA PIZZA?* 🍕\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Quieres agregar otra pizza a tu pedido?";
  
  return buttons(texto, [
    { id: "si", title: "✅ Sí" },
    { id: "no", title: "❌ No" },
    { id: "cancelar", title: "⏹️ Cancelar" }
  ]);
};

const deliveryButtons = (s) => {
  const suc = SUCURSALES[s.sucursal];
  const opciones = [];
  
  if (suc.domicilio) {
    opciones.push({ id: "domicilio", title: "🏠 A domicilio (+$40)" });
  }
  opciones.push({ id: "recoger", title: "🏪 Recoger en tienda" });
  opciones.push({ id: "cancelar", title: "❌ Cancelar" });
  
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `🚚 *MÉTODO DE ENTREGA* 🚚\n` +
    `   ${suc.emoji} ${suc.nombre}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Cómo quieres recibir tu pedido?";
  
  return buttons(texto, opciones);
};

const paymentOptions = (s) => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "💰 *MÉTODO DE PAGO* 💰\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "Selecciona cómo deseas pagar:";
  
  const opciones = [
    { id: "pago_efectivo", title: "💵 Efectivo" },
    { id: "pago_transferencia", title: "🏦 Transferencia" },
    { id: "cancelar", title: "❌ Cancelar" }
  ];
  
  return buttons(texto, opciones);
};

const paymentForzadoMessage = (s) => {
  const texto = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "💰 *SELECCIONA MÉTODO DE PAGO* 💰\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    `💵 *Total a pagar: $${s.totalTemp} MXN*\n\n` +
    "👇 *Selecciona una opción:*";
  
  return buttons(texto, [
    { id: "pago_transferencia", title: "🏦 Transferencia" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const confirmacionFinal = (s) => {
  const total = calcularTotal(s);
  const suc = SUCURSALES[s.sucursal];
  
  let resumen = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `📋 *CONFIRMA TU PEDIDO* 📋\n` +
    `   ${suc.emoji} ${suc.nombre}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  
  s.pizzas.forEach((p, i) => {
    const pizza = PRICES[p.type];
    resumen += `🍕 *PIZZA ${i+1}*\n`;
    resumen += `   ▸ ${pizza.emoji} ${pizza.nombre}\n`;
    resumen += `   ▸ ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    if (p.crust) resumen += `   ▸ 🧀 Orilla de queso\n`;
    if (p.extras?.length) {
      const extrasNombres = p.extras.map(e => EXTRAS[e].emoji + " " + EXTRAS[e].nombre).join(", ");
      resumen += `   ▸ ➕ Extras: ${extrasNombres}\n`;
    }
    resumen += "\n";
  });
  
  resumen += 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `💰 *TOTAL: $${total} MXN*\n` +
    `💳 *PAGO: ${s.pagoMetodo === "Transferencia" ? "🏦 Transferencia" : "💵 Efectivo"}*\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
    "¿Todo está correcto?";
  
  return buttons(resumen, [
    { id: "confirmar", title: "✅ Confirmar pedido" },
    { id: "cancelar", title: "❌ Cancelar" }
  ]);
};

const calcularTotal = (s) => {
  let total = 0;
  s.pizzas.forEach(p => {
    total += PRICES[p.type][p.size];
    if (p.crust) total += PRICES.orilla_queso.precio;
    total += p.extras.length * PRICES.extra.precio;
  });
  if (s.delivery) total += PRICES.envio.precio;
  return total;
};

const finalizarPedido = async (s, from) => {
  const suc = SUCURSALES[s.sucursal];
  const resumenCliente = buildSummary(s);
  const resumenNegocio = buildBusinessSummary(s);
  
  await sendMessage(from, resumenCliente);
  await sendMessage(suc.telefono, resumenNegocio);
  
  if (s.pagoMetodo === "Efectivo") {
    await sendMessage(suc.telefono, 
      textMsg(
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "💵 *PAGO EN EFECTIVO* 💵\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
        `👤 Cliente: ${from}\n` +
        `💰 Total: $${s.totalTemp} MXN\n\n` +
        "El cliente pagará al recibir."
      )
    );
  }
  
  delete sessions[from];
};

// =======================
// 📝 RESUMENES FINALES
// =======================
const buildBusinessSummary = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let total = 0;
  let text = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `🛎️ *NUEVO PEDIDO* 🛎️\n` +
    `   ${suc.emoji} ${suc.nombre}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  
  text += `👤 *CLIENTE:* ${s.clientNumber}\n\n`;

  s.pizzas.forEach((p, i) => {
    const pizza = PRICES[p.type];
    const pizzaPrice = pizza[p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   ▸ ${pizza.emoji} ${pizza.nombre}\n`;
    text += `   ▸ ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   ▸ Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   ▸ 🧀 Orilla de queso: +$${PRICES.orilla_queso.precio}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      const extrasNombres = p.extras.map(e => EXTRAS[e].emoji + " " + EXTRAS[e].nombre).join(", ");
      text += `   ▸ ➕ Extras: ${extrasNombres} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━━━━━━━━━━━━━━━━━━━━━━\n";

  if (s.delivery) {
    total += PRICES.envio.precio;
    text += `🚚 *ENTREGA:* A domicilio\n`;
    text += `   ▸ Envío: +$${PRICES.envio.precio}\n`;
    text += `   ▸ 📍 ${s.address}\n`;
    text += `   ▸ 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA:* Recoger en tienda\n`;
    text += `   ▸ 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += `💳 *PAGO:* ${s.pagoMetodo === "Transferencia" ? "🏦 Transferencia" : "💵 Efectivo"}\n`;
  if (s.pagoMetodo === "Transferencia") {
    text += `   ▸ Comprobante: ${s.comprobanteEnviado ? "✅ Recibido" : "⏳ Pendiente"}\n`;
  }
  text += "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  text += `🕒 *HORA:* ${new Date().toLocaleString('es-MX')}\n`;
  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += "✨ *Prepáralo con amor* ✨";

  return { type: "text", text: { body: text } };
};

const buildSummary = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let total = 0;
  let text = 
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    `✅ *¡PEDIDO CONFIRMADO!* ✅\n` +
    `   ${suc.emoji} ${suc.nombre}\n` +
    "━━━━━━━━━━━━━━━━━━━━━━\n\n";

  s.pizzas.forEach((p, i) => {
    const pizza = PRICES[p.type];
    const pizzaPrice = pizza[p.size];
    total += pizzaPrice;
    
    text += `🍕 *PIZZA ${i + 1}*\n`;
    text += `   ▸ ${pizza.emoji} ${pizza.nombre}\n`;
    text += `   ▸ ${p.size === "grande" ? "Grande" : "Extra grande"}\n`;
    text += `   ▸ Base: $${pizzaPrice}\n`;
    
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   ▸ 🧀 Orilla de queso: +$${PRICES.orilla_queso.precio}\n`;
    }
    
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      const extrasNombres = p.extras.map(e => EXTRAS[e].emoji + " " + EXTRAS[e].nombre).join(", ");
      text += `   ▸ ➕ Extras: ${extrasNombres} (+$${extrasTotal})\n`;
    }
    text += "\n";
  });

  text += "━━━━━━━━━━━━━━━━━━━━━━\n";

  if (s.delivery) {
    total += PRICES.envio.precio;
    text += `🚚 *ENTREGA:* A domicilio\n`;
    text += `   ▸ Envío: +$${PRICES.envio.precio}\n`;
    text += `   ▸ 📍 ${s.address}\n`;
    text += `   ▸ 📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *ENTREGA:* Recoger en tienda\n`;
    text += `   ▸ 🙋 Nombre: ${s.pickupName}\n\n`;
  }

  text += "━━━━━━━━━━━━━━━━━━━━━━\n";
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += "━━━━━━━━━━━━━━━━━━━━━━\n\n";
  text += `✨ *¡Gracias por tu pedido en ${suc.nombre}!*\n`;
  text += "🍕 Te esperamos pronto.";

  return textMsg(text);
};

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
  console.log(`🚀 Bot multisucursal V7 (Con corrección de pagos) corriendo en puerto ${PORT}`);
  console.log(`📱 Revolución: ${SUCURSALES.revolucion.telefono}`);
  console.log(`📱 La Obrera: ${SUCURSALES.obrera.telefono}`);
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
  console.log(`🔗 Test: https://one-whatsapp-bot.onrender.com/test-business`);
});