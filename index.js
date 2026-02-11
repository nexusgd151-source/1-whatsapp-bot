import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/* ==========================
   CONFIGURACIÓN
========================== */

const MENU = {
  "pepperoni": { nombre: "Pepperoni", G: 130, EG: 180 },
  "carnes": { nombre: "Carnes frías", G: 170, EG: 220 },
  "hawaiana": { nombre: "Hawaiana", G: 150, EG: 210 },
  "mexicana": { nombre: "Mexicana", G: 200, EG: 250 }
};

const PRECIO_EXTRA = 15;
const PRECIO_ORILLA = 40;
const ENVIO = 40;
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 min

let sesiones = {};

/* ==========================
   UTILIDADES
========================== */

function nuevaSesion() {
  return {
    step: "inicio",
    pizzas: [],
    total: 0,
    pizzaActual: {},
    lastActivity: Date.now(),
    locked: false
  };
}

function limpiarSesion(numero) {
  sesiones[numero] = nuevaSesion();
}

function sesionExpirada(s) {
  return Date.now() - s.lastActivity > SESSION_TIMEOUT;
}

async function enviarMensaje(numero, texto) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: numero,
      type: "text",
      text: { body: texto }
    })
  });
}

async function enviarBotones(numero, texto, botones) {
  botones.push("❌ Cancelar pedido");

  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: numero,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: texto },
        action: {
          buttons: botones.slice(0,3).map((b,i)=>({
            type:"reply",
            reply:{ id:`btn_${i}`, title:b }
          }))
        }
      }
    })
  });
}

/* ==========================
   BLOQUES
========================== */

async function mostrarInicio(numero) {
  await enviarBotones(numero,
`🍕 Bienvenido a Pizzería Villa
¿Qué deseas hacer?`,
["📖 Ver menú","🛒 Realizar pedido"]);
}

async function mostrarMenu(numero) {
  await enviarMensaje(numero,
`📖 MENÚ

Pepperoni G $130 | EG $180
Carnes frías G $170 | EG $220
Hawaiana G $150 | EG $210
Mexicana G $200 | EG $250

🧀 Orilla de queso $40
➕ Ingrediente extra $15
🚚 Envío $40`);
  await mostrarInicio(numero);
}

/* ==========================
   WEBHOOK
========================== */

app.post("/webhook", async (req,res)=>{
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!entry) return res.sendStatus(200);

    const from = entry.from;
    const texto = entry.text?.body || entry.button?.text || "";
    const mensaje = texto.trim().toLowerCase();

    if (!sesiones[from]) sesiones[from] = nuevaSesion();
    let session = sesiones[from];

    if (sesionExpirada(session)) limpiarSesion(from);

    session.lastActivity = Date.now();

    if (mensaje === "❌ cancelar pedido") {
      limpiarSesion(from);
      await enviarMensaje(from,"❌ Pedido cancelado.");
      return mostrarInicio(from);
    }

    if (session.locked) return res.sendStatus(200);
    session.locked = true;
    setTimeout(()=> session.locked=false,1000);

    switch(session.step){

      case "inicio":
        if (mensaje.includes("menú")) {
          await mostrarMenu(from);
        }
        else if (mensaje.includes("pedido")) {
          session.step="elegir_pizza";
          await enviarBotones(from,"🍕 Elige tu pizza:",
            Object.values(MENU).map(p=>`${p.nombre}`));
        }
        else {
          await mostrarInicio(from);
        }
      break;

      case "elegir_pizza":
        const key = Object.keys(MENU).find(k =>
          MENU[k].nombre.toLowerCase()===mensaje);
        if (!key) return mostrarInicio(from);

        session.pizzaActual = {
          nombre: MENU[key].nombre,
          key,
          extras: [],
          orilla:false
        };
        session.step="tamano";
        await enviarBotones(from,
`📏 Tamaño:
G $${MENU[key].G}
EG $${MENU[key].EG}`,
["Grande","Extra grande"]);
      break;

      case "tamano":
        if (!["grande","extra grande"].includes(mensaje))
          return enviarBotones(from,"Selecciona tamaño válido",
          ["Grande","Extra grande"]);

        session.pizzaActual.tamano =
          mensaje==="grande"?"G":"EG";

        session.total += MENU[session.pizzaActual.key][session.pizzaActual.tamano];

        session.step="orilla";
        await enviarBotones(from,
"🧀 ¿Agregar orilla de queso? ($40)",
["Sí","No"]);
      break;

      case "orilla":
        if (!["sí","no"].includes(mensaje))
          return enviarBotones(from,"Selecciona Sí o No",
          ["Sí","No"]);

        if (mensaje==="sí"){
          session.pizzaActual.orilla=true;
          session.total+=PRECIO_ORILLA;
        }

        session.step="extras";
        await enviarBotones(from,
"➕ ¿Agregar ingrediente extra? ($15)",
["Sí","No"]);
      break;

      case "extras":
        if (mensaje==="sí"){
          session.step="agregar_extra";
          await enviarBotones(from,
"Selecciona ingrediente extra:",
["Jamón","Piña","Champiñones"]);
        }
        else if (mensaje==="no"){
          session.pizzas.push(session.pizzaActual);
          session.pizzaActual={};
          session.step="otra_pizza";
          await enviarBotones(from,
"¿Agregar otra pizza?",
["Sí","No"]);
        }
        else{
          await enviarBotones(from,"Selecciona Sí o No",
          ["Sí","No"]);
        }
      break;

      case "agregar_extra":
        session.pizzaActual.extras.push(texto);
        session.total+=PRECIO_EXTRA;
        session.step="extras";
        await enviarBotones(from,
"¿Agregar otro extra?",
["Sí","No"]);
      break;

      case "otra_pizza":
        if (mensaje==="sí"){
          session.step="elegir_pizza";
          await enviarBotones(from,"🍕 Elige tu pizza:",
            Object.values(MENU).map(p=>`${p.nombre}`));
        }
        else if (mensaje==="no"){
          session.step="entrega";
          await enviarBotones(from,
"🚚 ¿Cómo deseas recibir tu pedido?",
["A domicilio","Recoger en tienda"]);
        }
        else{
          await enviarBotones(from,"Selecciona Sí o No",
          ["Sí","No"]);
        }
      break;

      case "entrega":
        if (mensaje.includes("domicilio")){
          session.tipoEntrega="domicilio";
          session.step="direccion";
          await enviarMensaje(from,"Escribe tu dirección completa:");
        }
        else if (mensaje.includes("recoger")){
          session.tipoEntrega="recoger";
          session.step="nombre";
          await enviarMensaje(from,"Escribe el
