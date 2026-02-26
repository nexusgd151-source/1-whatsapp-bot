const express = require("express");
const fetch = require("node-fetch");
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// 🚫 SISTEMA DE BLOQUEADOS PERMANENTE
// =======================
const BLOQUEADOS_FILE = path.join(__dirname, 'bloqueados.json');

let blockedNumbers = new Set();
try {
  const data = fs.readFileSync(BLOQUEADOS_FILE, 'utf8');
  blockedNumbers = new Set(JSON.parse(data));
  console.log(`📁 ${blockedNumbers.size} números bloqueados cargados`);
} catch (e) {
  console.log("📁 No hay bloqueados previos, creando archivo...");
  fs.writeFileSync(BLOQUEADOS_FILE, '[]');
}

function guardarBloqueados() {
  fs.writeFileSync(BLOQUEADOS_FILE, JSON.stringify(Array.from(blockedNumbers)));
}

// =======================
// 🏪 CONFIGURACIÓN DE SUCURSALES (sin "Obrera")
// =======================
const SUCURSALES = {
  revolucion: {
    nombre: "PIZZERIA DE VILLA REVOLUCIÓN (Colonia Revolución)",
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
    nombre: "PIZZERIA DE VILLA LA LABOR", // 👈 SOLO "La Labor"
    direccion: "Av Solidaridad 11-local 3, Oriente 2, 33029 Delicias, Chih.",
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

// =======================
// ⏰ CONFIGURACIÓN DE SESIÓN (10 MINUTOS)
// =======================
const SESSION_TIMEOUT = 10 * 60 * 1000;
const WARNING_TIME = 5 * 60 * 1000;
const UMBRAL_TRANSFERENCIA = 450;

// Tiempos de preparación personalizados
const TIEMPO_PREPARACION = {
  recoger: "15-30 minutos",     // Para llevar
  domicilio: "30-60 minutos"    // A domicilio
};

// Estados finales donde NO se deben enviar alertas de inactividad
const ESTADOS_FINALES = ["esperando_confirmacion", "esperando_confirmacion_sucursal", "completado"];

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
    pagoMetodo: null,
    delivery: null,
    address: null,
    phone: null,
    pickupName: null,
    pagoProcesado: false,
    pagosProcesados: {},
    resumenEnviado: false,
    warningSent: false,
    pedidoId: null,
    pagoId: null
  };
};

const isExpired = (s) => !ESTADOS_FINALES.includes(s.step) && now() - s.lastAction > SESSION_TIMEOUT;
const TEXT_ONLY_STEPS = ["ask_address", "ask_phone", "ask_pickup_name", "ask_comprobante"];

// =======================
// ⏰ FUNCIÓN PARA VERIFICAR Y ENVIAR AVISOS DE SESIÓN
// =======================
async function checkSessionWarning(from, s) {
  if (!sessions[from]) return true;
  
  // 🚫 NO enviar alertas si el pedido ya está en estados finales
  if (ESTADOS_FINALES.includes(s.step)) {
    return true;
  }
  
  const tiempoInactivo = now() - s.lastAction;
  
  if (tiempoInactivo > SESSION_TIMEOUT) {
    delete sessions[from];
    await sendMessage(from, textMsg(
      "⏰ *SESIÓN EXPIRADA*\n\n" +
      "Llevas más de 10 minutos sin actividad.\n" +
      "Tu pedido ha sido cancelado.\n\n" +
      "Escribe *Hola* para comenzar de nuevo. 🍕"
    ));
    return false;
  }
  
  return true;
}

// =======================
// ⏰ VERIFICACIÓN AUTOMÁTICA DE SESIONES
// =======================
setInterval(async () => {
  const ahora = now();
  
  for (const [from, s] of Object.entries(sessions)) {
    // 🚫 NO procesar si el pedido ya está en estados finales
    if (ESTADOS_FINALES.includes(s.step)) {
      continue;
    }
    
    const tiempoInactivo = ahora - s.lastAction;
    
    if (tiempoInactivo > SESSION_TIMEOUT) {
      console.log(`⏰ Sesión expirada automáticamente: ${from}`);
      await sendMessage(from, textMsg(
        "⏰ *SESIÓN EXPIRADA*\n\n" +
        "Llevas más de 10 minutos sin actividad.\n" +
        "Tu pedido ha sido cancelado.\n\n" +
        "Escribe *Hola* para comenzar de nuevo. 🍕"
      )).catch(e => console.log("Error al enviar mensaje de expiración"));
      delete sessions[from];
    }
    else if (tiempoInactivo > WARNING_TIME && !s.warningSent) {
      console.log(`⏳ Enviando aviso a ${from} (${Math.floor(tiempoInactivo / 60000)} min inactivo)`);
      s.warningSent = true;
      const minutosRestantes = Math.ceil((SESSION_TIMEOUT - tiempoInactivo) / 60000);
      await sendMessage(from, textMsg(
        "⏳ *¿SIGUES AHÍ?*\n\n" +
        `Llevas ${Math.floor(tiempoInactivo / 60000)} minutos sin actividad.\n` +
        `Tu sesión expirará en ${minutosRestantes} minutos si no respondes.\n\n` +
        "Responde para continuar con tu pedido. 🍕"
      )).catch(e => console.log("Error al enviar aviso"));
    }
  }
}, 60000);

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
      text: { body: "🧪 *PRUEBA LA LABOR*\n\nBot funcionando correctamente." } 
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

    // 🔥 VERIFICAR SESIÓN
    if (sessions[from]) {
      const sessionActiva = await checkSessionWarning(from, sessions[from]);
      if (!sessionActiva) {
        return res.sendStatus(200);
      }
    }

    // 🔥 DETECTAR IMAGEN (COMPROBANTE)
    if (msg.type === "image" || msg.type === "document") {
      console.log("🔥🔥🔥 IMAGEN DETECTADA 🔥🔥🔥");
      console.log(`📸 Cliente ${from} envió ${msg.type === "image" ? "imagen" : "documento"}`);
      
      // Verificar si el cliente tiene sesión
      if (!sessions[from]) {
        console.log(`❌ Cliente ${from} no tiene sesión activa`);
        await sendMessage(from, textMsg("❌ No tienes un pedido pendiente."));
        return res.sendStatus(200);
      }
      
      const s = sessions[from];
      console.log(`📍 Paso actual de ${from}: ${s.step}`);
      console.log(`💰 Total temporal: $${s.totalTemp}`);
      
      if (!s.sucursal) {
        console.log(`❌ Cliente ${from} no tiene sucursal seleccionada`);
        await sendMessage(from, textMsg("❌ Selecciona una sucursal primero."));
        return res.sendStatus(200);
      }
      
      const sucursal = SUCURSALES[s.sucursal];
      console.log(`🏪 Sucursal seleccionada: ${sucursal.nombre} (${sucursal.telefono})`);
      
      if (s.step !== "ask_comprobante") {
        console.log(`❌ Cliente ${from} envió imagen en paso incorrecto: ${s.step}`);
        await sendMessage(from, textMsg(
          "❌ *ERROR*\n\nNo estamos esperando un comprobante en este momento.\n" +
          "Por favor, continúa con el flujo normal del pedido."
        ));
        return res.sendStatus(200);
      }
      
      if (s.comprobanteCount >= 1) {
        console.log(`⚠️ Cliente ${from} intentó enviar múltiples comprobantes`);
        await sendMessage(from, textMsg(
          "⚠️ *COMPROBANTE YA ENVIADO*\n\n" +
          "Ya recibimos tu comprobante anteriormente.\n" +
          "Espera a que lo verifiquemos. ⏳"
        ));
        return res.sendStatus(200);
      }
      
      if (!s.totalTemp || s.totalTemp <= 0) {
        console.log(`❌ Cliente ${from} no tiene monto válido: ${s.totalTemp}`);
        await sendMessage(from, textMsg(
          "❌ *ERROR*\n\nNo hay información de monto para este pedido.\n" +
          "Por favor, comienza un nuevo pedido."
        ));
        delete sessions[from];
        return res.sendStatus(200);
      }
      
      s.comprobanteCount++;
      s.lastAction = now();
      s.warningSent = false;
      
      await sendMessage(from, textMsg(
        "✅ *COMPROBANTE RECIBIDO*\n\n" +
        "Hemos recibido tu comprobante.\n" +
        "Lo estamos verificando...\n\n" +
        "Te confirmaremos en minutos. ¡Gracias! 🙌"
      ));
      
      let imageId = null;
      let mimeType = null;
      
      if (msg.type === "image") {
        imageId = msg.image.id;
        mimeType = msg.image.mime_type || "image/jpeg";
        console.log(`🖼️ ID de imagen: ${imageId}, MIME: ${mimeType}`);
      } else if (msg.type === "document") {
        if (msg.document.mime_type?.startsWith("image/")) {
          imageId = msg.document.id;
          mimeType = msg.document.mime_type;
          console.log(`📄 Documento de imagen recibido, ID: ${imageId}, MIME: ${mimeType}`);
        } else {
          await sendMessage(from, textMsg("❌ El archivo no es una imagen. Envía una foto."));
          return res.sendStatus(200);
        }
      }
      
      if (!imageId) {
        console.log(`❌ No se pudo obtener ID de imagen`);
        await sendMessage(from, textMsg("❌ Error al procesar la imagen. Intenta de nuevo."));
        return res.sendStatus(200);
      }
      
      const timestamp = Date.now();
      const random = Math.floor(Math.random() * 1000);
      const pagoId = `${from}_${s.sucursal}_${timestamp}_${random}`;
      s.pagoId = pagoId;
      
      // Formato de hora con AM/PM correcto
      const horaActual = new Date().toLocaleString('es-MX', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true,
        hourCycle: 'h12'
      });
      
      const caption = 
        `🖼️ *COMPROBANTE DE PAGO*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🏪 *${sucursal.nombre}*\n` +
        `👤 *Cliente:* ${from}\n` +
        `💰 *Monto:* $${s.totalTemp} MXN\n` +
        `🆔 *Pago:* ${timestamp}\n` +
        `⏰ *Hora:* ${horaActual}`;
      
      // =======================
      // 🔥 ENVÍO DE LA IMAGEN
      // =======================
      try {
        console.log(`📤 Reenviando imagen directamente a la sucursal...`);
        
        // Intentar reenviar la imagen directamente usando el mismo ID
        await sendMessage(sucursal.telefono, {
          type: "image",
          image: { 
            id: imageId,
            caption: caption
          }
        });
        
        console.log(`✅ Imagen reenviada a sucursal ${sucursal.telefono}`);
      } catch (error) {
        console.error(`❌ Error al reenviar imagen:`, error);
        
        // Si falla el reenvío directo, intentamos con el método alternativo
        try {
          console.log(`🔄 Intentando método alternativo de descarga y subida...`);
          
          // 1. OBTENER URL de la imagen
          const mediaResponse = await fetch(`https://graph.facebook.com/v22.0/${imageId}`, {
            headers: { 
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`
            }
          });
          
          if (!mediaResponse.ok) {
            throw new Error(`Error al obtener URL de imagen: ${mediaResponse.status}`);
          }
          
          const mediaData = await mediaResponse.json();
          const imageUrl = mediaData.url;
          console.log(`📥 URL de imagen obtenida: ${imageUrl}`);
          
          // 2. DESCARGAR la imagen
          const imageResponse = await fetch(imageUrl, {
            headers: { 
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`
            }
          });
          
          if (!imageResponse.ok) {
            throw new Error(`Error al descargar imagen: ${imageResponse.status}`);
          }
          
          const imageBuffer = await imageResponse.buffer();
          console.log(`✅ Imagen descargada, tamaño: ${imageBuffer.length} bytes`);
          
          // 3. SUBIR la imagen a WhatsApp (nuevo ID)
          const formData = new FormData();
          formData.append('file', imageBuffer, {
            filename: 'comprobante.jpg',
            contentType: mimeType || 'image/jpeg'
          });
          formData.append('messaging_product', 'whatsapp');
          
          const uploadResponse = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/media`, {
            method: "POST",
            headers: {
              'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
              ...formData.getHeaders()
            },
            body: formData
          });
          
          if (!uploadResponse.ok) {
            const errorText = await uploadResponse.text();
            throw new Error(`Error al subir imagen: ${uploadResponse.status} - ${errorText}`);
          }
          
          const uploadData = await uploadResponse.json();
          const newImageId = uploadData.id;
          console.log(`✅ Imagen subida con nuevo ID: ${newImageId}`);
          
          // 4. Enviar con el nuevo ID
          await sendMessage(sucursal.telefono, {
            type: "image",
            image: { 
              id: newImageId,
              caption: caption
            }
          });
          
          console.log(`✅ Imagen enviada a sucursal usando método alternativo`);
        } catch (altError) {
          console.error(`❌ Error en método alternativo:`, altError);
          
          // Si todo falla, enviar mensaje de error a la sucursal
          await sendMessage(sucursal.telefono, textMsg(
            `⚠️ *ERROR AL ENVIAR COMPROBANTE*\n\n` +
            `Cliente: ${from}\n` +
            `Monto: $${s.totalTemp}\n\n` +
            `El comprobante no pudo ser enviado automáticamente.\n` +
            `Por favor, contacta al cliente para obtener el comprobante manualmente.`
          ));
        }
      }
      
      // Enviar botones de verificación a la sucursal
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
      
      s.comprobanteEnviado = true;
      s.step = "esperando_confirmacion";
      
      console.log(`✅ Proceso completado para cliente ${from} con ID ${pagoId}`);
      
      return res.sendStatus(200);
    }
    
    // 🔥 DETECTAR RESPUESTA DE SUCURSAL
    if (msg.type === "interactive" && msg.interactive?.button_reply) {
      const replyId = msg.interactive.button_reply.id;
      const fromSucursal = msg.from;
      
      console.log(`🔍 Botón presionado: ${replyId} por ${fromSucursal}`);
      
      if (replyId.startsWith("bloquear_")) {
        const numeroABloquear = replyId.replace("bloquear_", "");
        blockedNumbers.add(numeroABloquear);
        guardarBloqueados();
        
        await sendMessage(fromSucursal, {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: `✅ *CLIENTE BLOQUEADO*\n\nNúmero: ${numeroABloquear}\n\n¿Qué deseas hacer?` },
            action: {
              buttons: [
                { type: "reply", reply: { id: `desbloquear_${numeroABloquear}`, title: "🔓 DESBLOQUEAR" } },
                { type: "reply", reply: { id: `ok`, title: "✅ OK" } }
              ]
            }
          }
        });
        
        try {
          await sendMessage(numeroABloquear, textMsg(
            "🚫 *HAS SIDO BLOQUEADO*\n\n" +
            "Por comportamiento inapropiado, no podrás seguir usando el bot.\n" +
            "Si crees que es un error, contacta a la pizzería."
          ));
        } catch (e) {}
        
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("desbloquear_")) {
        const numeroADesbloquear = replyId.replace("desbloquear_", "");
        if (blockedNumbers.has(numeroADesbloquear)) {
          blockedNumbers.delete(numeroADesbloquear);
          guardarBloqueados();
          await sendMessage(fromSucursal, textMsg(`✅ *CLIENTE DESBLOQUEADO*\n\nNúmero: ${numeroADesbloquear}`));
        }
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("pago_ok_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const timestamp = partes[4];
        const random = partes[5];
        
        const pagoIdCompleto = `${cliente}_${sucursalKey}_${timestamp}_${random}`;
        console.log(`🔍 Buscando pago con ID: ${pagoIdCompleto}`);
        
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal || !sessions[cliente]) {
          console.log(`⚠️ Cliente ${cliente} no encontrado o sin sesión`);
          await sendMessage(fromSucursal, textMsg("⚠️ Cliente no encontrado"));
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        
        if (s.pagoId !== pagoIdCompleto) {
          console.log(`⚠️ ID de pago no coincide. Esperado: ${s.pagoId}, Recibido: ${pagoIdCompleto}`);
          await sendMessage(fromSucursal, textMsg(
            "⚠️ *ERROR*\n\nEste botón ya no es válido. El pago fue procesado con otro ID."
          ));
          return res.sendStatus(200);
        }
        
        if (s.pagoProcesado) {
          await sendMessage(fromSucursal, textMsg(
            "⚠️ *PAGO YA PROCESADO*\n\n" +
            "Este pago ya fue confirmado o rechazado anteriormente.\n" +
            "Los botones ya no son válidos."
          ));
          return res.sendStatus(200);
        }
        
        s.pagoProcesado = true;
        s.pagoResultado = "CONFIRMADO";
        s.pagoProcesadoPor = fromSucursal;
        s.pagoProcesadoEn = new Date().toISOString();
        
        if (!s.resumenEnviado) {
          await sendMessage(cliente, buildClienteSummary(s));
          await sendMessage(sucursal.telefono, buildNegocioSummary(s));
          s.resumenEnviado = true;
        }
        
        // Determinar el tiempo de preparación según el tipo de entrega
        const tiempoPrep = s.delivery ? TIEMPO_PREPARACION.domicilio : TIEMPO_PREPARACION.recoger;
        
        await sendMessage(cliente, textMsg(
          "✅ *¡PAGO CONFIRMADO!*\n\n" +
          `🏪 *${sucursal.nombre}*\n\n` +
          "Tu pedido ya está en preparación.\n" +
          `⏱️ Tiempo estimado: ${tiempoPrep}\n\n` +
          "¡Gracias por tu preferencia! 🙌"
        ));
        
        await sendMessage(fromSucursal, textMsg(
          "✅ *PAGO CONFIRMADO*\n\n" +
          `Cliente: ${cliente}\n` +
          `Monto: $${s.totalTemp}\n\n` +
          "El pedido puede prepararse.\n\n" +
          "🛑 *Los botones de este pago ya no son válidos.*"
        ));
        
        // Marcar como completado para evitar alertas de inactividad
        s.step = "completado";
        s.lastAction = now();
        
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("pago_no_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const timestamp = partes[4];
        const random = partes[5];
        
        const pagoIdCompleto = `${cliente}_${sucursalKey}_${timestamp}_${random}`;
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal || !sessions[cliente]) {
          await sendMessage(fromSucursal, textMsg("⚠️ Cliente no encontrado"));
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        
        if (s.pagoId !== pagoIdCompleto) {
          await sendMessage(fromSucursal, textMsg(
            "⚠️ *ERROR*\n\nEste botón ya no es válido. El pago fue procesado con otro ID."
          ));
          return res.sendStatus(200);
        }
        
        if (s.pagoProcesado) {
          await sendMessage(fromSucursal, textMsg(
            "⚠️ *PAGO YA PROCESADO*\n\n" +
            "Este pago ya fue confirmado o rechazado anteriormente.\n" +
            "Los botones ya no son válidos."
          ));
          return res.sendStatus(200);
        }
        
        s.pagoProcesado = true;
        s.pagoResultado = "RECHAZADO";
        s.pagoProcesadoPor = fromSucursal;
        s.pagoProcesadoEn = new Date().toISOString();
        
        await sendMessage(cliente, textMsg(
          "❌ *PAGO RECHAZADO*\n\n" +
          `🏪 *${sucursal.nombre}*\n\n` +
          "No pudimos verificar tu transferencia.\n" +
          `📞 Contacta: ${sucursal.telefono}`
        ));
        
        await sendMessage(fromSucursal, textMsg(
          `❌ *PAGO RECHAZADO*\n\n` +
          `Cliente: ${cliente}\n` +
          `Monto: $${s.totalTemp}\n\n` +
          "🛑 *Los botones de este pago ya no son válidos.*"
        ));
        
        // Marcar como completado (aunque sea rechazado, el proceso terminó)
        s.step = "completado";
        s.lastAction = now();
        
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("aceptar_")) {
        const pedidoId = replyId.replace("aceptar_", "");
        for (const [cliente, s] of Object.entries(sessions)) {
          if (s.pedidoId === pedidoId) {
            // Determinar el tiempo de preparación según el tipo de entrega
            const tiempoPrep = s.delivery ? TIEMPO_PREPARACION.domicilio : TIEMPO_PREPARACION.recoger;
            
            await sendMessage(cliente, textMsg(
              "✅ *¡PEDIDO ACEPTADO!*\n\n" +
              `🏪 *${SUCURSALES[s.sucursal].nombre}*\n\n` +
              "Tu pedido ha sido aceptado y ya está en preparación.\n" +
              `⏱️ Tiempo estimado: ${tiempoPrep}\n\n` +
              "¡Gracias por tu preferencia! 🙌"
            ));
            await sendMessage(fromSucursal, textMsg(`✅ *PEDIDO ACEPTADO*\n\nCliente: ${cliente}`));
            
            // Si es pago en efectivo, marcar como completado
            if (s.pagoMetodo === "Efectivo") {
              s.step = "completado";
              s.lastAction = now();
            }
            break;
          }
        }
        return res.sendStatus(200);
      }
      
      if (replyId.startsWith("rechazar_")) {
        const pedidoId = replyId.replace("rechazar_", "");
        for (const [cliente, s] of Object.entries(sessions)) {
          if (s.pedidoId === pedidoId) {
            await sendMessage(cliente, textMsg(
              "❌ *PEDIDO RECHAZADO*\n\n" +
              `🏪 *${SUCURSALES[s.sucursal].nombre}*\n\n` +
              "Lo sentimos, tu pedido no pudo ser aceptado.\n" +
              "Por favor, contacta a la sucursal para más información.\n\n" +
              `📞 Teléfono: ${SUCURSALES[s.sucursal].telefono}`
            ));
            await sendMessage(fromSucursal, textMsg(`❌ *PEDIDO RECHAZADO*\n\nCliente: ${cliente}`));
            
            // Marcar como completado (aunque sea rechazado, el proceso terminó)
            s.step = "completado";
            s.lastAction = now();
            break;
          }
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
    s.warningSent = false;

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
      await sendMessage(from, textMsg(
        "❌ *PEDIDO CANCELADO*\n\n" +
        "Tu pedido ha sido cancelado.\n" +
        "Escribe *Hola* para comenzar de nuevo. 🍕"
      ));
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
        
        s.pedidoId = `${from}_${Date.now()}`;
        
        const sucursalDestino = SUCURSALES[s.sucursal];
        const resumenPreliminar = buildPreliminarSummary(s);
        
        await sendMessage(sucursalDestino.telefono, resumenPreliminar);
        await sendMessage(sucursalDestino.telefono, {
          type: "interactive",
          interactive: {
            type: "button",
            body: { text: `📋 *NUEVO PEDIDO PARA RECOGER*\n\n¿Aceptas este pedido?` },
            action: {
              buttons: [
                { type: "reply", reply: { id: `aceptar_${s.pedidoId}`, title: "✅ ACEPTAR" } },
                { type: "reply", reply: { id: `rechazar_${s.pedidoId}`, title: "❌ RECHAZAR" } },
                { type: "reply", reply: { id: `bloquear_${from}`, title: "🚫 BLOQUEAR" } }
              ]
            }
          }
        });
        
        await sendMessage(from, textMsg(
          "📋 *PEDIDO ENVIADO*\n\n" +
          "Tu pedido ha sido enviado a la sucursal.\n" +
          "Espera la confirmación para saber si fue aceptado.\n\n" +
          "Te notificaremos en unos minutos. ⏳"
        ));
        
        s.step = "esperando_confirmacion_sucursal";
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
            s.pedidoId = `${from}_${Date.now()}`;
            const sucursalDestino = SUCURSALES[s.sucursal];
            const resumenPreliminar = buildPreliminarSummary(s);
            
            await sendMessage(sucursalDestino.telefono, resumenPreliminar);
            await sendMessage(sucursalDestino.telefono, {
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: `📋 *NUEVO PEDIDO A DOMICILIO (EFECTIVO)*\n\n¿Aceptas este pedido?` },
                action: {
                  buttons: [
                    { type: "reply", reply: { id: `aceptar_${s.pedidoId}`, title: "✅ ACEPTAR" } },
                    { type: "reply", reply: { id: `rechazar_${s.pedidoId}`, title: "❌ RECHAZAR" } },
                    { type: "reply", reply: { id: `bloquear_${from}`, title: "🚫 BLOQUEAR" } }
                  ]
                }
              }
            });
            
            await sendMessage(from, textMsg(
              "📋 *PEDIDO ENVIADO*\n\n" +
              "Tu pedido ha sido enviado a la sucursal.\n" +
              "Espera la confirmación para saber si fue aceptado.\n\n" +
              "Te notificaremos en minutos. ⏳"
            ));
            
            s.step = "esperando_confirmacion_sucursal";
            reply = null;
          }
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(
            textMsg("❌ *PEDIDO CANCELADO*\n\nEscribe *Hola* para comenzar de nuevo."), 
            seleccionarSucursal()
          );
        }
        break;

      case "ask_comprobante":
        reply = textMsg("📸 *ENVÍA TU COMPROBANTE*\n\nPresiona el clip 📎 y selecciona la foto.");
        break;

      case "esperando_confirmacion":
        reply = textMsg("⏳ *EN VERIFICACIÓN*\n\nYa recibimos tu comprobante. Te confirmaremos en minutos.");
        break;
        
      case "esperando_confirmacion_sucursal":
        reply = textMsg("⏳ *ESPERANDO CONFIRMACIÓN*\n\nTu pedido está siendo revisado por la sucursal.\n\nTe avisaremos cuando sea aceptado. 🍕");
        break;
        
      case "completado":
        reply = textMsg("✅ *PEDIDO COMPLETADO*\n\nGracias por tu compra. ¿Quieres hacer otro pedido? Escribe *Hola* para comenzar de nuevo. 🍕");
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
      { id: "obrera", title: "🏭 La Labor" }, // 👈 SOLO "La Labor"
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
    `🍕 Hawaiana: $150 / $220\n` +
    `🍕 Mexicana: $200 / $250\n\n` +
    `🧀 Orilla de queso: +$40\n` +
    `➕ Extras: $15 c/u\n` +
    `🚚 Envío: +$40\n\n` +
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
    "➕ *¿AGREGAR EXTRAS?*",
    [
      { id: "extra_si", title: "✅ Sí ($15 c/u)" },
      { id: "extra_no", title: "❌ No" },
      { id: "cancelar", title: "⏹️ Cancelar" }
    ]
  );
};

const extraList = () => {
  return list("➕ *ELIGE UN EXTRA* ($15 c/u)", [{
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
      { id: "extra_si", title: "✅ Sí ($15 c/u)" },
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
    opciones.push({ id: "domicilio", title: "🚚 A domicilio (+$40)" });
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
    if (p.crust) resumen += `   🧀 Orilla (+$40)\n`;
    if (p.extras?.length) {
      resumen += `   ➕ Extras: ${p.extras.join(", ")} (+$${p.extras.length * 15})\n`;
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

const buildPreliminarSummary = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let total = 0;
  let text = `📋 *NUEVO PEDIDO POR CONFIRMAR*\n🏪 ${suc.nombre}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${s.clientNumber}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    const precio = PRICES[p.type][p.size];
    total += precio;
    text += `🍕 *Pizza ${i+1}*\n`;
    text += `   ${p.type} (${p.size})\n`;
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   🧀 Orilla de queso (+$40)\n`;
    }
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
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
  
  text += `💳 *Pago:* ${s.pagoMetodo || "Efectivo"}\n`;
  
  return textMsg(text);
};

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
      text += `   🧀 Orilla de queso (+$40)\n`;
    }
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
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
  let text = `🛎️ *PEDIDO CONFIRMADO*\n🏪 ${suc.nombre}\n\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${s.clientNumber}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    const precio = PRICES[p.type][p.size];
    total += precio;
    text += `🍕 *Pizza ${i+1}*\n`;
    text += `   ${p.type} (${p.size})\n`;
    if (p.crust) {
      total += PRICES.orilla_queso.precio;
      text += `   🧀 Orilla de queso (+$40)\n`;
    }
    if (p.extras?.length) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += extrasTotal;
      text += `   ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
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
  
  // Formato de hora con AM/PM correcto
  text += `\n🕒 ${new Date().toLocaleString('es-MX', { 
    hour12: true, 
    hour: '2-digit', 
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })}\n`;
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
      console.log(`📤 Enviando a ${to}:`, JSON.stringify(m).substring(0, 200));
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
        const errorText = await response.text();
        console.error(`❌ Error en respuesta de WhatsApp: ${response.status} - ${errorText}`);
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
    const s = sessions[key];
    
    // Solo eliminar si no está en estado final Y ha expirado
    if (!ESTADOS_FINALES.includes(s.step) && nowTime - s.lastAction > SESSION_TIMEOUT) {
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
  console.log(`🚀 Bot V18 (Comprobantes con Descarga) corriendo en puerto ${PORT}`);
  console.log(`📱 Número de cliente (pruebas): 5216391946965`);
  console.log(`📱 Número de sucursal REVOLUCIÓN: 5216391283842`);
  console.log(`📱 Número de sucursal LA LABOR: 5216393992508`); // 👈 Cambiado
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
  console.log(`⏱️ Sin límite de tiempo entre pedidos`);
  console.log(`⏰ Sesión: 10 minutos (aviso a los 5 min)`);
  console.log(`⏱️ Tiempo preparación: Recoger ${TIEMPO_PREPARACION.recoger} | Domicilio ${TIEMPO_PREPARACION.domicilio}`);
  console.log(`🚫 Endpoint bloqueos: /bloquear/[numero]`);
  console.log(`✅ Endpoint desbloqueos: /desbloquear/[numero]`);
  console.log(`📋 Lista bloqueados: /bloqueados`);
  console.log(`🛑 Estados finales sin alertas: ${ESTADOS_FINALES.join(", ")}`);
});