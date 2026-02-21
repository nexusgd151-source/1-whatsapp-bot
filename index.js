const express = require("express");
const fetch = require("node-fetch");
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// 🚫 SISTEMA DE BLOQUEADOS PERMANENTE
// =======================
const BLOQUEADOS_FILE = path.join(__dirname, 'bloqueados.json');

// Cargar bloqueados al iniciar
let blockedNumbers = new Set();
try {
  const data = fs.readFileSync(BLOQUEADOS_FILE, 'utf8');
  blockedNumbers = new Set(JSON.parse(data));
  console.log(`📁 ${blockedNumbers.size} números bloqueados cargados`);
} catch (e) {
  console.log("📁 No hay bloqueados previos, creando archivo...");
  fs.writeFileSync(BLOQUEADOS_FILE, '[]');
}

// Función para guardar
function guardarBloqueados() {
  fs.writeFileSync(BLOQUEADOS_FILE, JSON.stringify(Array.from(blockedNumbers)));
}

// =======================
// 🛡️ PROTECCIÓN CONTRA SPAM DE COMPROBANTES
// =======================

// Tiempo mínimo entre mensajes del mismo cliente (en ms)
const MIN_TIME_BETWEEN_MESSAGES = 1000; // 1 segundo

// Cola de procesamiento por cliente
const messageQueue = {};

// Procesamiento seguro de mensajes
async function procesarMensajeSeguro(cliente, funcion) {
  // Si ya hay un mensaje en proceso para este cliente, lo encolamos
  if (messageQueue[cliente]?.procesando) {
    console.log(`⏳ Cliente ${cliente} ya tiene un mensaje en proceso, encolando...`);
    
    if (!messageQueue[cliente].cola) {
      messageQueue[cliente].cola = [];
    }
    
    return new Promise((resolve) => {
      messageQueue[cliente].cola.push({ funcion, resolve });
    });
  }
  
  // Inicializar la estructura para este cliente
  if (!messageQueue[cliente]) {
    messageQueue[cliente] = { procesando: false, cola: [], ultimoMensaje: 0 };
  }
  
  // Verificar tiempo mínimo entre mensajes
  const ahora = Date.now();
  if (ahora - messageQueue[cliente].ultimoMensaje < MIN_TIME_BETWEEN_MESSAGES) {
    console.log(`⏱️ Cliente ${cliente} envió mensajes muy rápido, ignorando...`);
    return null;
  }
  
  messageQueue[cliente].ultimoMensaje = ahora;
  messageQueue[cliente].procesando = true;
  
  try {
    const resultado = await funcion();
    return resultado;
  } finally {
    messageQueue[cliente].procesando = false;
    
    // Procesar siguiente mensaje en cola si existe
    if (messageQueue[cliente].cola && messageQueue[cliente].cola.length > 0) {
      const siguiente = messageQueue[cliente].cola.shift();
      procesarMensajeSeguro(cliente, siguiente.funcion).then(siguiente.resolve);
    }
  }
}

// =======================
// 🏪 CONFIGURACIÓN DE SUCURSALES
// =======================
const SUCURSALES = {
  revolucion: {
    nombre: "PIZZERIA DE VILLA REVOLUCIÓN",
    direccion: "Batalla de San Andres y Avenida Acceso Norte 418, Batalla de San Andrés Supermanzana Calla, 33100 Delicias, Chih.",
    emoji: "🏪",
    telefono: "5216391283842",
    domicilio: false,
    horario: "Lun-Dom 11am-9pm (Martes cerrado)",
    mercadoPago: {
      cuenta: "722969010279408583",
      beneficiario: "Gabriel Jair Serrato Betance"
    }
  },
  obrera: {
    nombre: "PIZZERIA DE VILLA LA OBRERA",
    direccion: "Av Solidaridad 11-local 3, Oriente 2, 33029 Delicias, Chih",
    emoji: "🏪",
    telefono: "5216393992508",
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
    extragrande: 220,
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
  pepperoni: { nombre: "Pepperoni", emoji: "🍖" },
  jamon: { nombre: "Jamón", emoji: "🥓" },
  jalapeno: { nombre: "Jalapeño", emoji: "🌶️" },
  pina: { nombre: "Piña", emoji: "🍍" },
  chorizo: { nombre: "Chorizo", emoji: "🌭" },
  queso: { nombre: "Queso", emoji: "🧀" }
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
    comprobanteCount: 0,
    ultimoMensajeId: null,
    pagoMetodo: null,
    delivery: null,
    address: null,
    phone: null,
    pickupName: null,
    pagoProcesado: false,
    pagosProcesados: {},
    resumenEnviado: false
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
// 🚫 ENDPOINTS PARA GESTIONAR BLOQUEOS
// =======================
app.get("/bloquear/:numero", (req, res) => {
  const numero = req.params.numero;
  blockedNumbers.add(numero);
  guardarBloqueados();
  res.send(`✅ Número ${numero} bloqueado permanentemente`);
});

app.get("/desbloquear/:numero", (req, res) => {
  const numero = req.params.numero;
  if (blockedNumbers.has(numero)) {
    blockedNumbers.delete(numero);
    guardarBloqueados();
    res.send(`✅ Número ${numero} desbloqueado`);
  } else {
    res.send(`⚠️ El número ${numero} no estaba bloqueado`);
  }
});

app.get("/bloqueados", (req, res) => {
  res.json(Array.from(blockedNumbers));
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

    // 🚫 VERIFICAR SI EL NÚMERO ESTÁ BLOQUEADO
    if (blockedNumbers.has(from)) {
      console.log(`🚫 Número bloqueado intentó contactar: ${from}`);
      await sendMessage(from, textMsg(
        "🚫 *CUENTA BLOQUEADA*\n\n" +
        "Has sido bloqueado por comportamiento inapropiado.\n" +
        "Si crees que es un error, contacta a la pizzería."
      ));
      return res.sendStatus(200);
    }

    // 🔥 DETECTAR IMAGEN (COMPROBANTE) - VERSIÓN CORREGIDA
    if (msg.type === "image" || msg.type === "document") {
      await procesarMensajeSeguro(from, async () => {
        console.log(`📸 Cliente ${from} envió ${msg.type === "image" ? "imagen" : "documento"}`);
        
        if (!sessions[from]) {
          await sendMessage(from, textMsg("❌ No tienes un pedido pendiente."));
          return;
        }
        
        const s = sessions[from];
        if (!s.sucursal) {
          await sendMessage(from, textMsg("❌ Selecciona una sucursal primero."));
          return;
        }
        
        const sucursal = SUCURSALES[s.sucursal];
        
        if (s.step !== "ask_comprobante" && s.step !== "esperando_confirmacion") {
          await sendMessage(from, textMsg("❌ No estamos esperando un comprobante."));
          return;
        }
        
        if (s.comprobanteCount >= 1) {
          await sendMessage(from, textMsg(
            "⚠️ *COMPROBANTE YA ENVIADO*\n\n" +
            "Ya recibimos tu comprobante anteriormente.\n" +
            "Espera a que lo verifiquemos. ⏳"
          ));
          return;
        }
        
        if (s.ultimoMensajeId === msg.id) {
          console.log(`🔄 Mensaje duplicado ignorado: ${msg.id}`);
          return;
        }
        s.ultimoMensajeId = msg.id;
        
        s.comprobanteCount++;
        
        await sendMessage(from, textMsg(
          "✅ *COMPROBANTE RECIBIDO*\n\n" +
          "Hemos recibido tu comprobante.\n" +
          "Lo estamos verificando...\n\n" +
          "Te confirmaremos en minutos. ¡Gracias! 🙌"
        ));
        
        let mediaPayload;
        let mediaType = "image";
        
        if (msg.type === "image") {
          mediaPayload = { id: msg.image.id };
        } else if (msg.type === "document") {
          if (msg.document.mime_type?.startsWith("image/")) {
            mediaPayload = { id: msg.document.id };
          } else {
            await sendMessage(from, textMsg("❌ El archivo no es una imagen. Envía una foto."));
            return;
          }
        }
        
        const pagoId = `${from}_${s.sucursal}_${Date.now()}`;
        s.pagoId = pagoId;
        const horaActual = new Date().toLocaleString('es-MX', { 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true 
        });
        
        const caption = 
          `🖼️ *COMPROBANTE DE PAGO*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `🏪 *${sucursal.nombre}*\n` +
          `👤 Cliente: ${from}\n` +
          `💰 Monto: $${s.totalTemp}\n` +
          `⏰ Hora: ${horaActual}`;
        
        await sendMessage(sucursal.telefono, {
          type: mediaType,
          [mediaType]: mediaPayload,
          caption: caption
        });
        
        await new Promise(resolve => setTimeout(resolve, 500));
        
        console.log(`📤 Enviando botones a ${sucursal.telefono} para pago $${s.totalTemp}`);
        await sendMessage(sucursal.telefono, {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: `🔍 *VERIFICAR PAGO - $${s.totalTemp}* (${horaActual})` },
            action: {
              buttons: [
                { type: "reply", reply: { id: `pago_ok_${pagoId}`, title: "✅ CONFIRMAR" } },
                { type: "reply", reply: { id: `pago_no_${pagoId}`, title: "❌ RECHAZAR" } },
                { type: "reply", reply: { id: `bloquear_${from}`, title: "🚫 BLOQUEAR" } }
              ]
            }
          }
        });
        console.log(`✅ Botones enviados a sucursal ${sucursal.telefono}`);
        
        s.comprobanteEnviado = true;
        s.step = "esperando_confirmacion";
      });
      
      // 👈 SIEMPRE RETORNAR DESPUÉS DE PROCESAR
      return res.sendStatus(200);
    }
    
    // 🔥 DETECTAR RESPUESTA DE SUCURSAL - CON PROTECCIÓN
    if (msg.type === "interactive" && msg.interactive?.button_reply) {
      const replyId = msg.interactive.button_reply.id;
      const fromSucursal = msg.from;
      
      console.log(`🔍 Botón presionado: ${replyId} por ${fromSucursal}`);
      
      // Verificar que no sea un mensaje duplicado
      if (sessions[fromSucursal]?.ultimoMensajeId === msg.id) {
        console.log(`🔄 Botón duplicado ignorado: ${msg.id}`);
        return res.sendStatus(200);
      }
      
      // Guardar ID del mensaje para evitar duplicados
      if (!sessions[fromSucursal]) {
        sessions[fromSucursal] = { ultimoMensajeId: msg.id };
      } else {
        sessions[fromSucursal].ultimoMensajeId = msg.id;
      }
      
      // ===== BOTÓN DE BLOQUEO =====
      if (replyId.startsWith("bloquear_")) {
        const numeroABloquear = replyId.replace("bloquear_", "");
        
        blockedNumbers.add(numeroABloquear);
        guardarBloqueados();
        
        await sendMessage(fromSucursal, textMsg(
          "✅ *CLIENTE BLOQUEADO*\n\n" +
          `Número: ${numeroABloquear}\n` +
          "Ya no podrá hacer pedidos."
        ));
        
        try {
          await sendMessage(numeroABloquear, textMsg(
            "🚫 *HAS SIDO BLOQUEADO*\n\n" +
            "Por comportamiento inapropiado, no podrás seguir usando el bot.\n" +
            "Si crees que es un error, contacta a la pizzería."
          ));
        } catch (e) {}
        
        return res.sendStatus(200);
      }
      
      // ===== BOTÓN CONFIRMAR PAGO =====
      if (replyId.startsWith("pago_ok_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal || !sessions[cliente]) {
          await sendMessage(fromSucursal, textMsg("⚠️ Cliente no encontrado"));
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        
        if (s.pagoProcesado) {
          await sendMessage(fromSucursal, textMsg("⚠️ Pago ya procesado"));
          return res.sendStatus(200);
        }
        
        s.pagoProcesado = true;
        
        if (!s.resumenEnviado) {
          await sendMessage(cliente, buildClienteSummary(s));
          await sendMessage(sucursal.telefono, buildNegocioSummary(s));
          s.resumenEnviado = true;
        }
        
        await sendMessage(cliente, textMsg(
          "✅ *¡PAGO CONFIRMADO!*\n\n" +
          `🏪 *${sucursal.nombre}*\n\n` +
          "Tu pedido ya está en preparación.\n" +
          "⏱️ Tiempo estimado: 30-40 min\n\n" +
          "¡Gracias por tu preferencia! 🙌"
        ));
        
        await sendMessage(fromSucursal, textMsg(
          "✅ *PAGO CONFIRMADO*\n\n" +
          `Cliente: ${cliente}\n` +
          `Monto: $${s.totalTemp}\n\n` +
          "El pedido puede prepararse."
        ));
        
        return res.sendStatus(200);
      }
      
      // ===== BOTÓN RECHAZAR PAGO =====
      if (replyId.startsWith("pago_no_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal || !sessions[cliente]) {
          await sendMessage(fromSucursal, textMsg("⚠️ Cliente no encontrado"));
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        s.pagoProcesado = true;
        
        await sendMessage(cliente, textMsg(
          "❌ *PAGO RECHAZADO*\n\n" +
          `🏪 *${sucursal.nombre}*\n\n` +
          "No pudimos verificar tu transferencia.\n" +
          `📞 Contacta: ${sucursal.telefono}`
        ));
        
        await sendMessage(fromSucursal, textMsg(
          `❌ *PAGO RECHAZADO*\n\n` +
          `Cliente: ${cliente}\n` +
          `Monto: $${s.totalTemp}`
        ));
        
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

    if (s.lastInput === input && !TEXT_ONLY_STEPS.includes(s.step)) {
      return res.sendStatus(200);
    }
    s.lastInput = input;

    if (!s.sucursal && s.step !== "seleccionar_sucursal") {
      resetSession(from);
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (input === "cancelar") {
      delete sessions[from];
      await sendMessage(from, textMsg("❌ Pedido cancelado."));
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    if (rawText && !TEXT_ONLY_STEPS.includes(s.step)) {
      await sendMessage(from, textMsg("⚠️ Usa los botones."));
      const botones = stepUI(s);
      if (botones) await sendMessage(from, botones);
      return res.sendStatus(200);
    }

    let reply = null;

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
          reply = merge(textMsg("❌ Opción inválida"), seleccionarSucursal());
        }
        break;

      case "welcome":
        if (input === "pedido") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "menu") {
          reply = merge(menuText(s), welcomeMessage(s));
        } else {
          reply = merge(textMsg("❌ Opción inválida"), welcomeMessage(s));
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
        if (!Object.keys(EXTRAS).includes(input)) {
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
          if (input === "recoger") {
            s.delivery = false;
            s.step = "ask_pickup_name";
            reply = textMsg("👤 *NOMBRE*\n\n¿Quién recogerá el pedido?");
          } else {
            reply = merge(
              textMsg("🚫 *SERVICIO NO DISPONIBLE*\n\nSolo recoger en tienda."),
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
              reply = paymentOptions();
            }
          } else if (input === "recoger") {
            s.delivery = false;
            s.step = "ask_pickup_name";
            reply = textMsg("👤 *NOMBRE*\n\n¿Quién recogerá el pedido?");
          } else {
            reply = merge(textMsg("❌ Opción no válida"), deliveryButtons(s));
          }
        }
        break;

      case "ask_payment":
        if (s.pagoForzado) {
          if (input !== "pago_transferencia") {
            reply = merge(textMsg("❌ Solo transferencia"), paymentForzadoMessage(s));
            break;
          }
          s.pagoMetodo = "Transferencia";
        } else {
          if (input === "pago_efectivo") {
            s.pagoMetodo = "Efectivo";
            s.step = "ask_address";
            reply = textMsg("📍 *DIRECCIÓN*\n\nEscribe tu dirección completa:");
            break;
          } else if (input === "pago_transferencia") {
            s.pagoMetodo = "Transferencia";
          } else {
            reply = merge(textMsg("❌ Selecciona método"), paymentOptions());
            break;
          }
        }
        
        s.step = "ask_address";
        reply = textMsg("📍 *DIRECCIÓN*\n\nEscribe tu dirección completa:");
        break;

      case "ask_address":
        if (!rawText || rawText.length < 5) {
          reply = textMsg("⚠️ Dirección inválida. Intenta de nuevo:");
          break;
        }
        s.address = rawText;
        s.step = "ask_phone";
        reply = textMsg("📞 *TELÉFONO*\n\nEscribe tu número a 10 dígitos:");
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
        
        const resumenCliente = buildClienteSummary(s);
        const resumenNegocio = buildNegocioSummary(s);
        
        await sendMessage(from, resumenCliente);
        await sendMessage(SUCURSALES[s.sucursal].telefono, resumenNegocio);
        
        delete sessions[from];
        reply = null;
        break;

      case "confirmacion_final":
        if (input === "confirmar") {
          if (s.pagoMetodo === "Transferencia") {
            s.step = "ask_comprobante";
            reply = textMsg(
              "🧾 *PAGO CON TRANSFERENCIA*\n\n" +
              "📲 *DATOS:*\n" +
              `🏦 Cuenta: ${SUCURSALES[s.sucursal].mercadoPago.cuenta}\n` +
              `👤 Beneficiario: ${SUCURSALES[s.sucursal].mercadoPago.beneficiario}\n` +
              `💰 Monto: $${s.totalTemp}\n\n` +
              "✅ *Envía la FOTO del comprobante*"
            );
          } else {
            const resumenCliente = buildClienteSummary(s);
            const resumenNegocio = buildNegocioSummary(s);
            
            await sendMessage(from, resumenCliente);
            await sendMessage(SUCURSALES[s.sucursal].telefono, resumenNegocio);
            
            delete sessions[from];
            reply = null;
          }
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(textMsg("❌ Pedido cancelado"), seleccionarSucursal());
        }
        break;

      case "ask_comprobante":
        reply = textMsg("📸 *ENVÍA TU COMPROBANTE*\n\nPresiona el clip 📎 y selecciona la foto.");
        break;

      case "esperando_confirmacion":
        reply = textMsg("⏳ *EN VERIFICACIÓN*\n\nYa recibimos tu comprobante. Te confirmaremos en minutos.");
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
  return buttons(
    "🏪 *PIZZERÍAS VILLA*\n\n¿En qué sucursal quieres pedir?",
    [
      { id: "revolucion", title: "🌋 Revolución" },
      { id: "obrera", title: "🏭 La Obrera" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const welcomeMessage = (s) => {
  const suc = SUCURSALES[s.sucursal];
  return buttons(
    `🏪 *${suc.nombre}*\n\n¿Qué deseas hacer?`,
    [
      { id: "pedido", title: "🛒 Hacer pedido" },
      { id: "menu", title: "📖 Ver menú" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const menuText = (s) => {
  const suc = SUCURSALES[s.sucursal];
  return textMsg(
    `📖 *MENÚ - ${suc.nombre}*\n\n` +
    `🍕 Pepperoni: $130 / $180\n` +
    `🍕 Carnes frías: $170 / $220\n` +
    `🍕 Hawaiana: $150 / $210\n` +
    `🍕 Mexicana: $200 / $250\n\n` +
    `🧀 Orilla de queso: +$40\n` +
    `➕ Extras: $15 c/u\n` +
    `🚚 Envío: $40\n\n` +
    `📍 ${suc.direccion}\n` +
    `🕒 ${suc.horario}`
  );
};

const pizzaList = () => {
  return list("🍕 *ELIGE TU PIZZA*", [{
    title: "PIZZAS",
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
  return buttons(
    `📏 *TAMAÑO*`,
    [
      { id: "grande", title: `Grande $${pizza.grande}` },
      { id: "extragrande", title: `Extra $${pizza.extragrande}` },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const askCrust = () => {
  return buttons(
    "🧀 *¿ORILLA DE QUESO?*",
    [
      { id: "crust_si", title: "✅ Sí (+$40)" },
      { id: "crust_no", title: "❌ No" },
      { id: "cancelar", title: "⏹️ Cancelar" }
    ]
  );
};

const askExtra = () => {
  return buttons(
    "➕ *¿EXTRAS?*",
    [
      { id: "extra_si", title: "✅ Sí" },
      { id: "extra_no", title: "❌ No" },
      { id: "cancelar", title: "⏹️ Cancelar" }
    ]
  );
};

const extraList = () => {
  return list("➕ *ELIGE UN EXTRA* ($15)", [{
    title: "EXTRAS",
    rows: Object.entries(EXTRAS).map(([id, extra]) => ({
      id: id,
      title: `${extra.emoji} ${extra.nombre}`,
      description: "+$15"
    }))
  }]);
};

const askMoreExtras = () => {
  return buttons(
    "➕ *¿OTRO EXTRA?*",
    [
      { id: "extra_si", title: "✅ Sí" },
      { id: "extra_no", title: "❌ No" },
      { id: "cancelar", title: "⏹️ Cancelar" }
    ]
  );
};

const anotherPizza = () => {
  return buttons(
    "🍕 *¿OTRA PIZZA?*",
    [
      { id: "si", title: "✅ Sí" },
      { id: "no", title: "❌ No" },
      { id: "cancelar", title: "⏹️ Cancelar" }
    ]
  );
};

const deliveryButtons = (s) => {
  const suc = SUCURSALES[s.sucursal];
  const opciones = [];
  
  if (suc.domicilio) {
    opciones.push({ id: "domicilio", title: "🚚 A domicilio" });
  }
  opciones.push({ id: "recoger", title: "🏪 Recoger en tienda" });
  opciones.push({ id: "cancelar", title: "❌ Cancelar" });
  
  return buttons("🚚 *ENTREGA*", opciones);
};

const paymentOptions = () => {
  return buttons(
    "💰 *PAGO*",
    [
      { id: "pago_efectivo", title: "💵 Efectivo" },
      { id: "pago_transferencia", title: "🏦 Transferencia" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const paymentForzadoMessage = (s) => {
  return buttons(
    `💰 *TOTAL: $${s.totalTemp}*\n\nSolo transferencia:`,
    [
      { id: "pago_transferencia", title: "🏦 Transferencia" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const confirmacionFinal = (s) => {
  const total = calcularTotal(s);
  const suc = SUCURSALES[s.sucursal];
  
  let resumen = `📋 *CONFIRMA TU PEDIDO*\n\n`;
  
  s.pizzas.forEach((p, i) => {
    resumen += `🍕 Pizza ${i+1}: ${p.type} ${p.size}\n`;
    if (p.crust) resumen += `   🧀 Orilla\n`;
    if (p.extras?.length) {
      resumen += `   ➕ ${p.extras.join(", ")}\n`;
    }
  });
  
  resumen += `\n💰 *TOTAL: $${total}*\n`;
  resumen += `💳 Pago: ${s.pagoMetodo}\n\n`;
  resumen += "¿Todo correcto?";
  
  return buttons(resumen, [
    { id: "confirmar", title: "✅ Confirmar" },
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

// =======================
// 📝 RESUMENES
// =======================

const buildClienteSummary = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let total = 0;
  let text = `✅ *PEDIDO CONFIRMADO*\n🏪 ${suc.nombre}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  s.pizzas.forEach((p, i) => {
    const precio = PRICES[p.type][p.size];
    total += precio;
    text += `🍕 *Pizza ${i+1}*\n`;
    text += `   ${p.type} (${p.size})\n`;
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   🧀 Orilla de queso\n`;
    }
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.join(", ")}\n`;
    }
    text += `   $${precio}\n\n`;
  });
  
  text += `━━━━━━━━━━━━━━━━━━\n`;
  
  if (s.delivery) {
    total += PRICES.envio.precio;
    text += `🚚 *Envío a domicilio*\n`;
    text += `   +$${PRICES.envio.precio}\n`;
    text += `📍 ${s.address}\n`;
    text += `📞 ${s.phone}\n\n`;
  } else {
    text += `🏪 *Recoger en tienda*\n`;
    text += `   Nombre: ${s.pickupName}\n\n`;
  }
  
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 *TOTAL: $${total} MXN*\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `✨ ¡Gracias por tu pedido!\n`;
  text += `🍕 Pizzerías Villa`;
  
  return textMsg(text);
};

const buildNegocioSummary = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let total = 0;
  let text = `🛎️ *NUEVO PEDIDO*\n🏪 ${suc.nombre}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${s.clientNumber}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    const precio = PRICES[p.type][p.size];
    total += precio;
    text += `🍕 *Pizza ${i+1}*\n`;
    text += `   ${p.type} (${p.size})\n`;
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   🧀 Orilla de queso\n`;
    }
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.join(", ")}\n`;
    }
    text += `   $${precio}\n`;
  });
  
  text += `\n━━━━━━━━━━━━━━━━━━\n`;
  text += `💰 *TOTAL: $${total}*\n`;
  
  if (s.delivery) {
    text += `🚚 *Domicilio*\n`;
    text += `   Envío: +$${PRICES.envio.precio}\n`;
    text += `   📍 ${s.address}\n`;
    text += `   📞 ${s.phone}\n`;
  } else {
    text += `🏪 *Recoger*\n`;
    text += `   Nombre: ${s.pickupName}\n`;
  }
  
  if (s.pagoMetodo) {
    text += `💳 *Pago:* ${s.pagoMetodo}\n`;
    if (s.pagoMetodo === "Transferencia") {
      text += `   Comprobante: ${s.comprobanteEnviado ? "✅ Recibido" : "⏳ Pendiente"}\n`;
    }
  }
  
  text += `\n🕒 ${new Date().toLocaleString('es-MX')}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n`;
  text += `✨ Prepáralo con amor`;
  
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
    case "ask_payment": return s.pagoForzado ? paymentForzadoMessage(s) : paymentOptions();
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
  console.log(`🚀 Bot V13 (Totalmente Corregido) corriendo en puerto ${PORT}`);
  console.log(`📱 Revolución: ${SUCURSALES.revolucion.telefono}`);
  console.log(`📱 La Obrera: ${SUCURSALES.obrera.telefono}`);
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
  console.log(`🚫 Endpoint bloqueos: /bloquear/[numero]`);
  console.log(`✅ Endpoint desbloqueos: /desbloquear/[numero]`);
  console.log(`📋 Lista bloqueados: /bloqueados`);
  console.log(`🛡️ Anti-spam: ACTIVADO`);
});