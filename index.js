const express = require("express");
const fetch = require("node-fetch");
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const moment = require('moment-timezone'); // 👈 NUEVO: Para manejar hora de México

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =======================
// 📌 SISTEMA DE FOLIOS DIARIOS
// =======================
const FOLIOS_FILE = path.join(__dirname, 'folios.json');

let folioActual = 1;
let fechaActual = new Date().toDateString();

function obtenerFolio() {
  const hoy = new Date().toDateString();
  
  // Si es un nuevo día, reiniciar folio
  if (hoy !== fechaActual) {
    console.log(`📅 Día cambiado: ${fechaActual} -> ${hoy}. Reiniciando folio.`);
    fechaActual = hoy;
    folioActual = 1;
  }
  
  const folio = folioActual;
  folioActual++;
  
  // Guardar en archivo para persistencia
  try {
    fs.writeFileSync(FOLIOS_FILE, JSON.stringify({
      fecha: fechaActual,
      folio: folioActual
    }));
  } catch (e) {
    console.log("❌ Error guardando folio:", e.message);
  }
  
  return folio;
}

// Cargar folio guardado si existe
try {
  if (fs.existsSync(FOLIOS_FILE)) {
    const data = fs.readFileSync(FOLIOS_FILE, 'utf8');
    const saved = JSON.parse(data);
    const hoy = new Date().toDateString();
    
    if (saved.fecha === hoy) {
      folioActual = saved.folio;
      fechaActual = saved.fecha;
      console.log(`📌 Folio cargado: ${folioActual} para hoy ${fechaActual}`);
    } else {
      console.log(`📅 Día diferente. Reiniciando folio a 1.`);
    }
  } else {
    console.log("📌 Archivo de folios no existe. Comenzando con folio 1.");
  }
} catch (e) {
  console.log("❌ Error cargando folios:", e.message);
}

// =======================
// 📞 FUNCIÓN PARA FORMATEAR NÚMERO (QUITAR 52 Y 1)
// =======================
function formatearNumero(numero) {
  if (!numero) return numero;
  
  // Convertir a string por si acaso
  const numStr = String(numero);
  
  // Si viene con 521, quitar el 52 y el 1
  if (numStr.startsWith('521')) {
    return numStr.substring(3); // Quita 521
  }
  // Si solo viene con 52, quitar el 52
  else if (numStr.startsWith('52')) {
    return numStr.substring(2);
  }
  return numStr;
}

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
// 🎁 CONFIGURACIÓN DE OFERTA ESPECIAL
// =======================
const OFERTA_ESPECIAL = {
  activa: true,
  nombre: "Pepperoni Grande $100",
  pizza: "pepperoni",
  tamaño: "grande",
  precio_base: 100,
  precio_normal: 130,
  dias_validos: [5, 6, 0], // 5=viernes, 6=sábado, 0=domingo
  
  mensaje_bienvenida: "🎉 *OFERTA ESPECIAL POR TIEMPO LIMITADO*\n🔥 Pepperoni Grande - $100\n   ✨ Válido solo este fin de semana",
  
  mensaje_confirmacion: "🎁 *OFERTA ESPECIAL POR TIEMPO LIMITADO*\n\n🔥 *Pepperoni Grande - $100*\n\n✅ INCLUYE:\n   • Pizza pepperoni tamaño GRANDE\n   • Precio base: $100\n\n✨ Personaliza con EXTRAS (+$15 c/u):\n   🍖 Pepperoni • 🥓 Jamón • 🌶️ Jalapeño\n   🍍 Piña • 🌭 Chorizo • 🌭 Salchicha Italiana\n   🌭 Salchicha Asar • 🧀 Queso • 🥓 Tocino\n   🧅 Cebolla\n\n⚠️ *Válido solo este fin de semana*\n   Viernes, Sábado y Domingo\n   (No te lo pierdas)",
  
  mensaje_aviso: "⚠️ *¡TE ESTÁS PERDIENDO UNA OFERTA!*\n\n🎉 *OFERTA ESPECIAL POR TIEMPO LIMITADO*\n🔥 Pepperoni Grande por solo $100\n   (En lugar de $130)\n\n✨ Válido solo este fin de semana\n   Viernes, Sábado y Domingo"
};

function ofertaActiva() {
  if (!OFERTA_ESPECIAL.activa) return false;
  const ahoraMexico = moment().tz("America/Mexico_City");
  const hoy = ahoraMexico.day(); // 0=domingo, 1=lunes, ..., 6=sábado (hora México)
  return OFERTA_ESPECIAL.dias_validos.includes(hoy);
}

// =======================
// ⏰ CONFIGURACIÓN DE TIEMPO PARA ACEPTACIÓN DE PEDIDOS
// =======================
const TIEMPO_MAXIMO_ACEPTACION = 60 * 60 * 1000; // 1 hora en milisegundos

// =======================
// 🏪 CONFIGURACIÓN DE SUCURSALES
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
    nombre: "PIZZERIA DE VILLA LA LABOR",
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

// =======================
// 🍕 EXTRAS COMPLETOS
// =======================
const EXTRAS = {
  pepperoni: { nombre: "Pepperoni", emoji: "🍖" },
  jamon: { nombre: "Jamón", emoji: "🥓" },
  jalapeno: { nombre: "Jalapeño", emoji: "🌶️" },
  pina: { nombre: "Piña", emoji: "🍍" },
  chorizo: { nombre: "Chorizo", emoji: "🌭" },
  salchicha_italiana: { nombre: "Salchicha Italiana", emoji: "🌭" },
  salchicha_asar: { nombre: "Salchicha para Asar", emoji: "🌭" },
  queso: { nombre: "Queso", emoji: "🧀" },
  tocino: { nombre: "Tocino", emoji: "🥓" },
  cebolla: { nombre: "Cebolla", emoji: "🧅" }
};

const sessions = {};

// =======================
// 🆕 FUNCIÓN PARA INICIAR NUEVA SESIÓN (SIEMPRE LIMPIA)
// =======================
function iniciarNuevaSesion(from, mensajeInicial) {
  // Siempre eliminar sesión anterior si existe
  if (sessions[from]) {
    console.log(`🔄 Reiniciando sesión para ${from} (anterior: ${sessions[from].step})`);
    delete sessions[from];
  }
  
  // Crear sesión nueva
  resetSession(from);
  
  // Enviar mensaje de bienvenida
  if (mensajeInicial) {
    sendMessage(from, mensajeInicial);
  }
}

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
    pagoId: null,
    pizzaSeleccionada: null,
    es_oferta: false,
    pedidoEnviadoEn: null,
    folio: null
  };
};

const isExpired = (s) => !ESTADOS_FINALES.includes(s.step) && now() - s.lastAction > SESSION_TIMEOUT;
const TEXT_ONLY_STEPS = ["ask_address", "ask_phone", "ask_pickup_name", "ask_comprobante"];

// =======================
// ⏰ FUNCIÓN PARA VERIFICAR HORARIO (CORREGIDA CON MOMENT-TIMEZONE)
// =======================
function verificarHorario() {
  const ahoraMexico = moment().tz("America/Mexico_City");
  const hora = ahoraMexico.hours();
  const dia = ahoraMexico.day(); // 0=Domingo, 1=Lunes...
  
  console.log(`🇲🇽 Hora México: ${ahoraMexico.format('HH:mm')} - Día: ${dia} (${ahoraMexico.format('dddd')})`);
  
  // Horario: 11:00 AM a 9:00 PM (hora México)
  // Martes cerrado (dia === 2)
  if (dia === 2) {
    return {
      abierto: false,
      mensaje: "🕒 *TIENDA CERRADA (MARTES)*\n\nNuestro horario es de 11:00 AM a 9:00 PM.\nLos martes permanecemos cerrados.\n\nVuelve mañana en nuestro horario de atención. 🍕"
    };
  }
  
  if (hora < 11 || hora >= 21) {
    return {
      abierto: false,
      mensaje: `🕒 *TIENDA CERRADA*\n\nSon las ${ahoraMexico.format('HH:mm')} hrs (hora México).\nNuestro horario es de 11:00 AM a 9:00 PM.\nVuelve en nuestro horario de atención. 🍕`
    };
  }
  
  return { 
    abierto: true,
    mensaje: `✅ Tienda abierta - ${ahoraMexico.format('HH:mm')} hrs (hora México)`
  };
}

// =======================
// ⏰ FUNCIÓN PARA VERIFICAR Y ENVIAR AVISOS DE SESIÓN
// =======================
async function checkSessionWarning(from, s) {
  if (!sessions[from]) return true;
  
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
// ⏰ FUNCIÓN PARA VERIFICAR PEDIDOS PENDIENTES
// =======================
async function verificarPedidosPendientes() {
  const ahora = now();
  const TIEMPO_LIMPIEZA_NOCTURNA = 12 * 60 * 60 * 1000; // 12 horas
  
  for (const [from, s] of Object.entries(sessions)) {
    
    // CASO 1: Pedidos esperando confirmación de la sucursal
    if (s.step === "esperando_confirmacion_sucursal") {
      const tiempoEspera = ahora - (s.pedidoEnviadoEn || s.lastAction);
      
      // ✅ VERIFICAR SI EL PEDIDO YA FUE ACEPTADO
      const pedidoAceptado = 
        s.pagoProcesado ||              // Pago procesado
        s.resumenEnviado ||              // Resumen enviado
        s.step === "completado";         // Paso completado
      
      // Si ya fue aceptado, cambiar el estado
      if (pedidoAceptado) {
        if (s.step !== "completado") {
          console.log(`✅ Pedido ${s.pedidoId} ya fue aceptado, marcando como completado`);
          s.step = "completado";
        }
        continue;
      }
      
      // Si NO ha sido aceptado y pasó más de 1 hora, cancelar
      if (tiempoEspera > TIEMPO_MAXIMO_ACEPTACION) {
        console.log(`⏰ Pedido ${s.pedidoId} expiró después de ${Math.floor(tiempoEspera / 60000)} minutos`);
        
        // Notificar al cliente
        await sendMessage(from, textMsg(
          "⏰ *PEDIDO EXPIRADO*\n\n" +
          `Han pasado más de 1 hora y la sucursal no ha respondido.\n\n` +
          `Tu pedido ha sido cancelado automáticamente.\n` +
          `Escribe *Hola* para hacer un nuevo pedido. 🍕`
        )).catch(e => console.log("Error al notificar expiración"));
        
        // Notificar a la sucursal
        const sucursal = SUCURSALES[s.sucursal];
        if (sucursal) {
          await sendMessage(sucursal.telefono, textMsg(
            `⏰ *PEDIDO EXPIRADO*\n\n` +
            `Cliente: ${formatearNumero(from)}\n` +
            `Pedido: #${s.folio || 'Sin folio'}\n\n` +
            `Cancelado automáticamente después de 1 hora sin respuesta.`
          )).catch(e => console.log("Error al notificar a sucursal"));
        }
        
        // Eliminar la sesión
        delete sessions[from];
      }
    }
    
    // CASO 2: Limpieza de sesiones muy antiguas
    const tiempoSesion = ahora - s.lastAction;
    if (tiempoSesion > TIEMPO_LIMPIEZA_NOCTURNA) {
      console.log(`🧹 Limpiando sesión antigua de ${from} (${Math.floor(tiempoSesion / 3600000)} horas)`);
      delete sessions[from];
    }
  }
}

// =======================
// ⏰ VERIFICACIÓN AUTOMÁTICA DE SESIONES
// =======================
setInterval(async () => {
  const ahora = now();
  
  for (const [from, s] of Object.entries(sessions)) {
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
// ⏰ VERIFICACIÓN DE PEDIDOS PENDIENTES (cada 5 minutos)
// =======================
setInterval(() => {
  verificarPedidosPendientes();
}, 5 * 60 * 1000); // Verificar cada 5 minutos

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
// TEST - VER HORA ACTUAL (CORREGIDO CON MOMENT-TIMEZONE)
// =======================
app.get("/test-hora", (req, res) => {
  const ahoraUTC = moment().utc();
  const ahoraMexico = moment().tz("America/Mexico_City");
  
  const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  
  const horario = verificarHorario();
  
  res.json({
    servidor_UTC: {
      hora: ahoraUTC.format('HH:mm'),
      dia: dias[ahoraUTC.day()],
      fecha: ahoraUTC.format('YYYY-MM-DD HH:mm:ss') + ' UTC'
    },
    mexico_CDT: {
      hora: ahoraMexico.format('HH:mm'),
      dia: dias[ahoraMexico.day()],
      fecha: ahoraMexico.format('YYYY-MM-DD HH:mm:ss') + ' México'
    },
    horario_abierto: horario.abierto ? "SÍ" : "NO",
    mensaje: horario.mensaje,
    folio_actual: folioActual,
    fecha_folio: fechaActual
  });
});

// =======================
// TEST - VER PEDIDOS ACTIVOS
// =======================
app.get("/test-pedidos", (req, res) => {
  const pedidosActivos = [];
  
  for (const [cliente, s] of Object.entries(sessions)) {
    if (s.pedidoId && s.step === "esperando_confirmacion_sucursal") {
      pedidosActivos.push({
        cliente: formatearNumero(cliente),
        pedidoId: s.pedidoId,
        folio: s.folio,
        sucursal: s.sucursal,
        tiempo: Math.floor((now() - (s.pedidoEnviadoEn || s.lastAction)) / 60000) + " minutos"
      });
    }
  }
  
  res.json({
    pedidos_activos: pedidosActivos,
    total: pedidosActivos.length
  });
});

// =======================
// TEST - ENVIAR MENSAJE A SUCURSALES
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
// 🎨 FUNCIONES UI DE OFERTA
// =======================
const avisoOferta = () => {
  return buttons(
    OFERTA_ESPECIAL.mensaje_aviso + "\n\n¿Qué deseas hacer?",
    [
      { id: "ver_oferta", title: "🎁 VER OFERTA" },
      { id: "continuar_normal", title: "🛒 Continuar normal" },
      { id: "volver_inicio", title: "🔄 Volver al inicio" }
    ]
  );
};

const confirmarOferta = () => {
  return buttons(
    OFERTA_ESPECIAL.mensaje_confirmacion + "\n\n¿Quieres agregar esta pizza?",
    [
      { id: "confirmar_oferta_si", title: "✅ Sí, agregar" },
      { id: "confirmar_oferta_no", title: "❌ No, volver" }
    ]
  );
};

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

    // 🆕 SI EL MENSAJE ES "HOLA" O SIMILAR, REINICIAR SIEMPRE
    const rawTextLower = msg.text?.body?.toLowerCase() || "";
    const palabrasReinicio = ["hola", "nuevo pedido", "empezar", "menu", "inicio", "reiniciar"];
    if (palabrasReinicio.includes(rawTextLower)) {
      console.log(`🆕 Cliente ${from} quiere comenzar de nuevo. Reiniciando sesión.`);
      iniciarNuevaSesion(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    // 🔥 VERIFICAR SESIÓN
    if (sessions[from]) {
      const sessionActiva = await checkSessionWarning(from, sessions[from]);
      if (!sessionActiva) {
        return res.sendStatus(200);
      }
    } else {
      // No hay sesión, crear una nueva
      resetSession(from);
      await sendMessage(from, seleccionarSucursal());
      return res.sendStatus(200);
    }

    // 🔥 VERIFICAR HORARIO (solo para clientes)
    const esSucursal = Object.values(SUCURSALES).some(s => s.telefono === from);
    if (!esSucursal) {
      const horario = verificarHorario();
      if (!horario.abierto) {
        await sendMessage(from, textMsg(horario.mensaje));
        return res.sendStatus(200);
      }
    }

    // 🔥 DETECTAR IMAGEN (COMPROBANTE)
    if (msg.type === "image" || msg.type === "document") {
      console.log("🔥🔥🔥 IMAGEN DETECTADA 🔥🔥🔥");
      console.log(`📸 Cliente ${from} envió ${msg.type === "image" ? "imagen" : "documento"}`);
      
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
      
      const ahoraMexico = moment().tz("America/Mexico_City");
      const horaActual = ahoraMexico.format('hh:mm A');
      
      const telefonoFormateado = formatearNumero(from);
      
      const caption = 
        `🖼️ *COMPROBANTE DE PAGO*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🏪 *${sucursal.nombre}*\n` +
        `👤 *Cliente:* ${telefonoFormateado}\n` +
        `💰 *Monto:* $${s.totalTemp} MXN\n` +
        `🆔 *Pago:* ${timestamp}\n` +
        `⏰ *Hora:* ${horaActual} (México)`;
      
      try {
        console.log(`📤 Reenviando imagen directamente a la sucursal...`);
        
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
        
        try {
          console.log(`🔄 Intentando método alternativo de descarga y subida...`);
          
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
          
          await sendMessage(sucursal.telefono, textMsg(
            `⚠️ *ERROR AL ENVIAR COMPROBANTE*\n\n` +
            `Cliente: ${telefonoFormateado}\n` +
            `Monto: $${s.totalTemp}\n\n` +
            `El comprobante no pudo ser enviado automáticamente.\n` +
            `Por favor, contacta al cliente para obtener el comprobante manualmente.`
          ));
        }
      }
      
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
      const replyTitle = msg.interactive.button_reply.title;
      
      console.log(`🔍 Botón presionado: ${replyId} (${replyTitle}) por ${fromSucursal}`);
      
      // ✅ VERIFICAR QUE ES UNA SUCURSAL VÁLIDA
      const esSucursalValida = Object.values(SUCURSALES).some(s => s.telefono === fromSucursal);
      if (!esSucursalValida) {
        console.log(`⚠️ Número ${fromSucursal} no es una sucursal registrada`);
        return res.sendStatus(200);
      }
      
      // ===== BLOQUEAR CLIENTE =====
      if (replyId.startsWith("bloquear_")) {
        const numeroABloquear = replyId.replace("bloquear_", "");
        blockedNumbers.add(numeroABloquear);
        guardarBloqueados();
        
        await sendMessage(fromSucursal, textMsg(`✅ Cliente ${formatearNumero(numeroABloquear)} bloqueado`));
        
        try {
          await sendMessage(numeroABloquear, textMsg(
            "🚫 *HAS SIDO BLOQUEADO*\n\n" +
            "Por comportamiento inapropiado, no podrás seguir usando el bot."
          ));
        } catch (e) {}
        
        return res.sendStatus(200);
      }
      
      // ===== DESBLOQUEAR CLIENTE =====
      if (replyId.startsWith("desbloquear_")) {
        const numeroADesbloquear = replyId.replace("desbloquear_", "");
        if (blockedNumbers.has(numeroADesbloquear)) {
          blockedNumbers.delete(numeroADesbloquear);
          guardarBloqueados();
          await sendMessage(fromSucursal, textMsg(`✅ Cliente ${formatearNumero(numeroADesbloquear)} desbloqueado`));
        }
        return res.sendStatus(200);
      }
      
      // ===== ACEPTAR PEDIDO =====
      if (replyId.startsWith("aceptar_")) {
        const pedidoId = replyId.replace("aceptar_", "");
        console.log(`✅ Procesando aceptación de pedido: ${pedidoId}`);
        
        let pedidoEncontrado = false;
        
        for (const [cliente, s] of Object.entries(sessions)) {
          if (s.pedidoId === pedidoId) {
            pedidoEncontrado = true;
            
            // Verificar que la sucursal que acepta es la correcta
            const sucursalPedido = SUCURSALES[s.sucursal];
            if (sucursalPedido.telefono !== fromSucursal) {
              console.log(`⚠️ Sucursal incorrecta: ${fromSucursal} intentó aceptar pedido de ${sucursalPedido.telefono}`);
              await sendMessage(fromSucursal, textMsg("⚠️ Este pedido no corresponde a tu sucursal"));
              return res.sendStatus(200);
            }
            
            const tiempoPrep = s.delivery ? TIEMPO_PREPARACION.domicilio : TIEMPO_PREPARACION.recoger;
            const telefonoFormateado = formatearNumero(cliente);
            
            // 1️⃣ ENVIAR CONFIRMACIÓN AL CLIENTE
            await sendMessage(cliente, textMsg(
              `✅ *¡PEDIDO #${s.folio} ACEPTADO!*\n\n` +
              `🏪 *${sucursalPedido.nombre}*\n\n` +
              `👤 Cliente: ${telefonoFormateado}\n\n` +
              "Tu pedido ha sido aceptado y ya está en preparación.\n" +
              `⏱️ Tiempo estimado: ${tiempoPrep}\n\n` +
              "¡Gracias por tu preferencia! 🙌"
            ));
            
            // 2️⃣ ENVIAR CONFIRMACIÓN A LA SUCURSAL
            await sendMessage(fromSucursal, textMsg(
              `✅ *PEDIDO #${s.folio} ACEPTADO*\n\n` +
              `Cliente: ${telefonoFormateado}\n` +
              `El pedido puede prepararse.`
            ));
            
            // 3️⃣ MARCAR EL PEDIDO COMO COMPLETADO
            s.step = "completado";
            s.pagoProcesado = true;
            s.lastAction = now();
            
            console.log(`✅ Pedido ${pedidoId} aceptado por sucursal ${fromSucursal}`);
            break;
          }
        }
        
        if (!pedidoEncontrado) {
          console.log(`⚠️ Pedido no encontrado: ${pedidoId}`);
          await sendMessage(fromSucursal, textMsg("⚠️ El pedido ya no existe o expiró"));
        }
        
        return res.sendStatus(200);
      }
      
      // ===== RECHAZAR PEDIDO =====
      if (replyId.startsWith("rechazar_")) {
        const pedidoId = replyId.replace("rechazar_", "");
        console.log(`❌ Procesando rechazo de pedido: ${pedidoId}`);
        
        let pedidoEncontrado = false;
        
        for (const [cliente, s] of Object.entries(sessions)) {
          if (s.pedidoId === pedidoId) {
            pedidoEncontrado = true;
            
            const sucursalPedido = SUCURSALES[s.sucursal];
            const telefonoFormateado = formatearNumero(cliente);
            
            // Notificar al cliente
            await sendMessage(cliente, textMsg(
              "❌ *PEDIDO RECHAZADO*\n\n" +
              `🏪 *${sucursalPedido.nombre}*\n\n` +
              `📋 Pedido: #${s.folio}\n` +
              `👤 Cliente: ${telefonoFormateado}\n\n` +
              "Lo sentimos, tu pedido no pudo ser aceptado.\n" +
              "Por favor, contacta a la sucursal para más información.\n\n" +
              `📞 Teléfono: ${sucursalPedido.telefono}`
            ));
            
            // Notificar a la sucursal
            await sendMessage(fromSucursal, textMsg(
              `❌ *PEDIDO #${s.folio} RECHAZADO*\n\n` +
              `Cliente: ${telefonoFormateado}`
            ));
            
            // Marcar como completado
            s.step = "completado";
            s.lastAction = now();
            
            console.log(`❌ Pedido ${pedidoId} rechazado por sucursal ${fromSucursal}`);
            break;
          }
        }
        
        if (!pedidoEncontrado) {
          await sendMessage(fromSucursal, textMsg("⚠️ El pedido ya no existe o expiró"));
        }
        
        return res.sendStatus(200);
      }
      
      // ===== PAGO CONFIRMADO =====
      if (replyId.startsWith("pago_ok_")) {
        const partes = replyId.split("_");
        const cliente = partes[2];
        const sucursalKey = partes[3];
        const timestamp = partes[4];
        const random = partes[5];
        
        const pagoIdCompleto = `${cliente}_${sucursalKey}_${timestamp}_${random}`;
        console.log(`💰 Confirmando pago: ${pagoIdCompleto}`);
        
        const sucursal = SUCURSALES[sucursalKey];
        
        if (!sucursal || !sessions[cliente]) {
          await sendMessage(fromSucursal, textMsg("⚠️ Cliente no encontrado"));
          return res.sendStatus(200);
        }
        
        const s = sessions[cliente];
        
        if (s.pagoId !== pagoIdCompleto) {
          await sendMessage(fromSucursal, textMsg("⚠️ Este botón ya no es válido"));
          return res.sendStatus(200);
        }
        
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
        
        const tiempoPrep = s.delivery ? TIEMPO_PREPARACION.domicilio : TIEMPO_PREPARACION.recoger;
        const telefonoFormateado = formatearNumero(cliente);
        
        await sendMessage(cliente, textMsg(
          `✅ *¡PAGO CONFIRMADO!*\n\n` +
          `🏪 *${sucursal.nombre}*\n\n` +
          `📋 Pedido: #${s.folio}\n` +
          `👤 Cliente: ${telefonoFormateado}\n\n` +
          `⏱️ Tiempo estimado: ${tiempoPrep}`
        ));
        
        await sendMessage(fromSucursal, textMsg(
          `✅ *PAGO CONFIRMADO*\n\n` +
          `Cliente: ${telefonoFormateado}\n` +
          `Folio: #${s.folio}`
        ));
        
        s.step = "completado";
        s.lastAction = now();
        
        return res.sendStatus(200);
      }
      
      // ===== PAGO RECHAZADO =====
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
          await sendMessage(fromSucursal, textMsg("⚠️ Este botón ya no es válido"));
          return res.sendStatus(200);
        }
        
        if (s.pagoProcesado) {
          await sendMessage(fromSucursal, textMsg("⚠️ Pago ya procesado"));
          return res.sendStatus(200);
        }
        
        s.pagoProcesado = true;
        
        const telefonoFormateado = formatearNumero(cliente);
        
        await sendMessage(cliente, textMsg(
          "❌ *PAGO RECHAZADO*\n\n" +
          `🏪 *${sucursal.nombre}*\n\n` +
          `📋 Pedido: #${s.folio}\n` +
          `👤 Cliente: ${telefonoFormateado}\n\n` +
          `📞 Contacta: ${sucursal.telefono}`
        ));
        
        await sendMessage(fromSucursal, textMsg(
          `❌ *PAGO RECHAZADO*\n\n` +
          `Cliente: ${telefonoFormateado}\n` +
          `Folio: #${s.folio}`
        ));
        
        s.step = "completado";
        s.lastAction = now();
        
        return res.sendStatus(200);
      }
    }

    // ===== MANEJO NORMAL DEL FLUJO DEL BOT =====
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
        } else if (input === "ver_oferta" && ofertaActiva()) {
          s.step = "confirmar_oferta";
          reply = confirmarOferta();
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
        
        s.pizzaSeleccionada = input;
        
        if (input === "pepperoni" && ofertaActiva()) {
          s.step = "aviso_oferta";
          reply = avisoOferta();
        } else {
          s.currentPizza.type = input;
          s.currentPizza.extras = [];
          s.currentPizza.crust = false;
          s.currentPizza.es_oferta = false;
          s.step = "size";
          reply = sizeButtons(input);
        }
        break;

      case "aviso_oferta":
        if (input === "ver_oferta") {
          s.step = "confirmar_oferta";
          reply = confirmarOferta();
        } else if (input === "continuar_normal") {
          s.currentPizza.type = s.pizzaSeleccionada;
          s.currentPizza.extras = [];
          s.currentPizza.crust = false;
          s.currentPizza.es_oferta = false;
          s.step = "size";
          reply = sizeButtons(s.pizzaSeleccionada);
        } else if (input === "volver_inicio") {
          s.step = "welcome";
          reply = welcomeMessage(s);
        } else {
          reply = merge(textMsg("❌ Opción no válida"), avisoOferta());
        }
        break;

      case "confirmar_oferta":
        if (input === "confirmar_oferta_si") {
          s.currentPizza = {
            type: OFERTA_ESPECIAL.pizza,
            size: OFERTA_ESPECIAL.tamaño,
            extras: [],
            crust: false,
            es_oferta: true
          };
          s.step = "ask_extra";
          reply = askExtra();
        } else if (input === "confirmar_oferta_no") {
          s.step = "welcome";
          reply = welcomeMessage(s);
        } else {
          reply = merge(textMsg("❌ Opción no válida"), confirmarOferta());
        }
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
          s.step = "elegir_tipo_pizza";
          const opciones = [
            { id: "normal", title: "🍕 Pizza normal" }
          ];
          
          if (ofertaActiva()) {
            opciones.unshift({ id: "otra_oferta", title: "🎁 Otra oferta" });
          }
          
          opciones.push({ id: "cancelar", title: "❌ Cancelar" });
          
          reply = buttons(
            "🍕 *¿QUÉ TIPO DE PIZZA QUIERES?*\n\n" +
            (ofertaActiva() ? "🎁 Oferta especial disponible\n" : "") +
            "Elige una opción:",
            opciones
          );
        } else if (input === "no") {
          s.step = "delivery_method";
          reply = deliveryButtons(s);
        } else {
          reply = merge(textMsg("❌ Opción no válida"), anotherPizza());
        }
        break;

      case "elegir_tipo_pizza":
        if (input === "otra_oferta" && ofertaActiva()) {
          s.currentPizza = {
            type: OFERTA_ESPECIAL.pizza,
            size: OFERTA_ESPECIAL.tamaño,
            extras: [],
            crust: false,
            es_oferta: true
          };
          s.step = "ask_extra";
          reply = askExtra();
        } else if (input === "normal") {
          s.step = "pizza_type";
          reply = pizzaList();
        } else if (input === "cancelar") {
          delete sessions[from];
          reply = merge(textMsg("❌ Pedido cancelado"), seleccionarSucursal());
        } else {
          reply = merge(textMsg("❌ Opción no válida"), welcomeMessage(s));
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
        
        // Generar folio para el pedido
        if (!s.folio) {
          s.folio = obtenerFolio();
        }
        
        s.pedidoId = `${from}_${Date.now()}`;
        s.pedidoEnviadoEn = now();
        
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
        
        const telefonoFormateado = formatearNumero(from);
        
        await sendMessage(from, textMsg(
          `📋 *PEDIDO #${s.folio} ENVIADO*\n\n` +
          `👤 Cliente: ${telefonoFormateado}\n\n` +
          "Tu pedido ha sido enviado a la sucursal.\n" +
          "Espera la confirmación para saber si fue aceptado.\n\n" +
          "⏱️ *La sucursal tiene 1 hora para confirmar*\n" +
          "Si no confirman en ese tiempo, el pedido se cancelará automáticamente.\n\n" +
          "Te notificaremos cuando haya una respuesta. ⏳"
        ));
        
        s.step = "esperando_confirmacion_sucursal";
        reply = null;
        break;

      case "confirmacion_final":
        if (input === "confirmar") {
          // Generar folio para el pedido
          if (!s.folio) {
            s.folio = obtenerFolio();
          }
          
          if (s.pagoMetodo === "Transferencia") {
            s.step = "ask_comprobante";
            reply = textMsg(
              `🧾 *PAGO CON TRANSFERENCIA - PEDIDO #${s.folio}*\n\n` +
              "📲 *DATOS:*\n" +
              `🏦 Cuenta: ${SUCURSALES[s.sucursal].mercadoPago.cuenta}\n` +
              `👤 Beneficiario: ${SUCURSALES[s.sucursal].mercadoPago.beneficiario}\n` +
              `💰 Monto: $${s.totalTemp}\n\n` +
              "✅ *Envía la FOTO del comprobante*"
            );
          } else {
            s.pedidoId = `${from}_${Date.now()}`;
            s.pedidoEnviadoEn = now();
            
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
            
            const telefonoFormateado = formatearNumero(from);
            
            await sendMessage(from, textMsg(
              `📋 *PEDIDO #${s.folio} ENVIADO*\n\n` +
              `👤 Cliente: ${telefonoFormateado}\n\n` +
              "Tu pedido ha sido enviado a la sucursal.\n" +
              "Espera la confirmación para saber si fue aceptado.\n\n" +
              "⏱️ *La sucursal tiene 1 hora para confirmar*\n" +
              "Si no confirman en ese tiempo, el pedido se cancelará automáticamente.\n\n" +
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
        const telefonoFormateadoComp = formatearNumero(from);
        reply = textMsg(
          `📸 *ENVÍA TU COMPROBANTE - PEDIDO #${s.folio}*\n\n` +
          `👤 Cliente: ${telefonoFormateadoComp}\n\n` +
          "Presiona el clip 📎 y selecciona la foto."
        );
        break;

      case "esperando_confirmacion":
        reply = textMsg("⏳ *EN VERIFICACIÓN*\n\nYa recibimos tu comprobante. Te confirmaremos en minutos.");
        break;
        
      case "esperando_confirmacion_sucursal":
        reply = textMsg("⏳ *ESPERANDO CONFIRMACIÓN*\n\nTu pedido está siendo revisado por la sucursal.\n\nTe avisaremos cuando sea aceptado o si pasa más de 1 hora se cancelará automáticamente. 🍕");
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
      { id: "obrera", title: "🏭 La Labor" },
      { id: "cancelar", title: "❌ Cancelar" }
    ]
  );
};

const welcomeMessage = (s) => {
  const suc = SUCURSALES[s.sucursal];
  const opciones = [];
  
  let mensaje = `🏪 *${suc.nombre}*\n\n`;
  
  if (ofertaActiva()) {
    mensaje += `${OFERTA_ESPECIAL.mensaje_bienvenida}\n\n`;
  }
  
  mensaje += "¿Qué deseas hacer?";
  
  if (ofertaActiva()) {
    opciones.push(
      { id: "ver_oferta", title: "🎁 VER OFERTA" },
      { id: "pedido", title: "🛒 Hacer pedido" },
      { id: "menu", title: "📖 Ver menú" }
    );
  } else {
    opciones.push(
      { id: "pedido", title: "🛒 Hacer pedido" },
      { id: "menu", title: "📖 Ver menú" },
      { id: "cancelar", title: "❌ Cancelar" }
    );
  }
  
  return buttons(mensaje, opciones);
};

const menuText = (s) => {
  const suc = SUCURSALES[s.sucursal];
  let menu = `📖 *MENÚ - ${suc.nombre}*\n\n`;
  
  if (ofertaActiva()) {
    menu += `🎁 *OFERTA ESPECIAL:* Pepperoni Grande $100\n\n`;
  }
  
  menu += `🍕 Pepperoni: $130 / $180\n` +
    `🍕 Carnes frías: $170 / $220\n` +
    `🍕 Hawaiana: $150 / $220\n` +
    `🍕 Mexicana: $200 / $250\n\n` +
    `🧀 Orilla de queso: +$40\n` +
    `➕ Extras: $15 c/u\n` +
    `🚚 Envío: +$40\n\n` +
    `📍 ${suc.direccion}\n` +
    `🕒 ${suc.horario}`;
  
  return textMsg(menu);
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
  const extrasOrdenados = [
    "pepperoni", "jamon", "jalapeno", "pina", 
    "chorizo", "salchicha_italiana", "salchicha_asar", 
    "queso", "tocino", "cebolla"
  ];
  
  const rows = extrasOrdenados.map(id => ({
    id: id,
    title: `${EXTRAS[id].emoji} ${EXTRAS[id].nombre}`,
    description: "+$15"
  }));
  
  return list("➕ *ELIGE UN EXTRA* ($15 c/u)", [{
    title: "EXTRAS",
    rows: rows
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
  const telefonoFormateado = formatearNumero(s.clientNumber);
  
  let resumen = `📋 *CONFIRMA TU PEDIDO*\n\n`;
  resumen += `📋 Pedido #${s.folio || "Nuevo"}\n`;
  resumen += `👤 Cliente: ${telefonoFormateado}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    if (p.es_oferta) {
      resumen += `🎁 Pizza ${i+1}: Pepperoni Grande (Oferta $100)\n`;
      if (p.extras?.length) {
        const extrasLista = p.extras.map(e => `${EXTRAS[e].emoji} ${EXTRAS[e].nombre}`).join(", ");
        resumen += `   ➕ Extras: ${extrasLista} (+$${p.extras.length * 15})\n`;
      }
    } else {
      resumen += `🍕 Pizza ${i+1}: ${PRICES[p.type].nombre} ${p.size}\n`;
      if (p.crust) resumen += `   🧀 Orilla (+$40)\n`;
      if (p.extras?.length) {
        const extrasLista = p.extras.map(e => `${EXTRAS[e].emoji} ${EXTRAS[e].nombre}`).join(", ");
        resumen += `   ➕ Extras: ${extrasLista} (+$${p.extras.length * 15})\n`;
      }
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
    if (p.es_oferta) {
      total += OFERTA_ESPECIAL.precio_base;
      total += p.extras.length * PRICES.extra.precio;
    } else {
      total += PRICES[p.type][p.size];
      if (p.crust) total += PRICES.orilla_queso.precio;
      total += p.extras.length * PRICES.extra.precio;
    }
  });
  
  if (s.delivery) total += PRICES.envio.precio;
  
  return total;
};

const buildPreliminarSummary = (s) => {
  if (!s.folio) {
    s.folio = obtenerFolio();
  }
  
  const suc = SUCURSALES[s.sucursal];
  const telefonoFormateado = formatearNumero(s.clientNumber);
  let total = 0;
  
  let text = `📋 *PEDIDO #${s.folio} POR CONFIRMAR*\n`;
  text += `🏪 ${suc.nombre}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${telefonoFormateado}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    if (p.es_oferta) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += OFERTA_ESPECIAL.precio_base + extrasTotal;
      
      text += `🎁 *Pizza ${i+1} (Oferta)*\n`;
      text += `   Pepperoni Grande - $${OFERTA_ESPECIAL.precio_base}\n`;
      if (p.extras?.length) {
        text += `   ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
      }
    } else {
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
    }
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
  text += `━━━━━━━━━━━━━━━━━━\n`;
  
  return textMsg(text);
};

const buildClienteSummary = (s) => {
  if (!s.folio) {
    s.folio = obtenerFolio();
  }
  
  const suc = SUCURSALES[s.sucursal];
  const telefonoFormateado = formatearNumero(s.clientNumber);
  let total = 0;
  
  let text = `✅ *PEDIDO #${s.folio} CONFIRMADO*\n`;
  text += `🏪 ${suc.nombre}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${telefonoFormateado}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    if (p.es_oferta) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += OFERTA_ESPECIAL.precio_base + extrasTotal;
      
      text += `🎁 *Pizza ${i+1} (Oferta)*\n`;
      text += `   Pepperoni Grande - $${OFERTA_ESPECIAL.precio_base}\n`;
      if (p.extras?.length) {
        text += `   ➕ Extras: ${p.extras.map(e => EXTRAS[e].emoji + " " + EXTRAS[e].nombre).join(", ")} (+$${extrasTotal})\n`;
      }
      text += `\n`;
    } else {
      const precio = PRICES[p.type][p.size];
      total += precio;
      text += `🍕 *Pizza ${i+1}*\n`;
      text += `   ${PRICES[p.type].nombre} (${p.size})\n`;
      if (p.crust) {
        total += PRICES.orilla_queso.precio;
        text += `   🧀 Orilla de queso (+$40)\n`;
      }
      if (p.extras?.length) {
        const extrasTotal = p.extras.length * PRICES.extra.precio;
        total += extrasTotal;
        text += `   ➕ Extras: ${p.extras.map(e => EXTRAS[e].emoji + " " + EXTRAS[e].nombre).join(", ")} (+$${extrasTotal})\n`;
      }
      text += `   $${precio}\n\n`;
    }
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
  const telefonoFormateado = formatearNumero(s.clientNumber);
  let total = 0;
  
  let text = `🛎️ *PEDIDO #${s.folio} CONFIRMADO*\n`;
  text += `🏪 ${suc.nombre}\n`;
  text += `━━━━━━━━━━━━━━━━━━\n\n`;
  text += `👤 *Cliente:* ${telefonoFormateado}\n\n`;
  
  s.pizzas.forEach((p, i) => {
    if (p.es_oferta) {
      const extrasTotal = p.extras.length * PRICES.extra.precio;
      total += OFERTA_ESPECIAL.precio_base + extrasTotal;
      
      text += `🎁 *Pizza ${i+1} (Oferta)*\n`;
      text += `   Pepperoni Grande - $${OFERTA_ESPECIAL.precio_base}\n`;
      if (p.extras?.length) {
        text += `   ➕ Extras: ${p.extras.join(", ")} (+$${extrasTotal})\n`;
      }
    } else {
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
    }
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
  
  const ahoraMexico = moment().tz("America/Mexico_City");
  text += `\n🕒 ${ahoraMexico.format('hh:mm A')} - ${ahoraMexico.format('DD/MM/YYYY')} (México)\n`;
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
  console.log(`🚀 Bot V22 (Horario México CORREGIDO) corriendo en puerto ${PORT}`);
  console.log(`📅 Fecha actual del servidor: ${new Date().toDateString()}`);
  console.log(`📌 Folio actual: ${folioActual}`);
  console.log(`📱 Número de cliente (pruebas): 5216391946965 → ${formatearNumero("5216391946965")}`);
  console.log(`📱 Número de sucursal REVOLUCIÓN: 5216391283842 → ${formatearNumero("5216391283842")}`);
  console.log(`📱 Número de sucursal LA LABOR: 5216393992508 → ${formatearNumero("5216393992508")}`);
  console.log(`💰 Umbral transferencia: $${UMBRAL_TRANSFERENCIA}`);
  console.log(`⏰ Sesión: 10 minutos (aviso a los 5 min)`);
  console.log(`⏱️ Tiempo preparación: Recoger ${TIEMPO_PREPARACION.recoger} | Domicilio ${TIEMPO_PREPARACION.domicilio}`);
  console.log(`🎁 Oferta especial: ${ofertaActiva() ? "ACTIVA" : "INACTIVA"} (Vie-Sáb-Dom)`);
  console.log(`⏰ Tiempo máximo para aceptar pedidos: 1 HORA`);
  console.log(`🇲🇽 Horario: 11:00 AM - 9:00 PM (HORA MÉXICO) - CORREGIDO`);
  console.log(`🚫 Endpoint bloqueos: /bloquear/[numero]`);
  console.log(`✅ Endpoint desbloqueos: /desbloquear/[numero]`);
  console.log(`📋 Lista bloqueados: /bloqueados`);
  console.log(`🕒 Test hora (México): /test-hora`);
  console.log(`📋 Test pedidos activos: /test-pedidos`);
});