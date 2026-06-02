import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const PORT = Number(process.env.PORT || 10000);
const DOMAIN =
  process.env.RENDER_EXTERNAL_URL ||
  "https://ana-200gruas.onrender.com";

const WS_URL = `wss://${DOMAIN.replace(/^https?:\/\//, "")}/ws`;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const SYSTEM_PROMPT =
  process.env.ANA_SYSTEM_PROMPT ||
  "Eres Ana, una operadora telefónica profesional de servicios de grúas en Panamá.";

const WELCOME_GREETING =
  process.env.WELCOME_GREETING ||
  "Buenas, servicio de grúas a la orden.";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const fastify = Fastify({ logger: false });

await fastify.register(fastifyWebsocket);
await fastify.register(fastifyFormbody);

const sessions = new Map();
const notifiedCalls = new Set();
const closingCalls = new Set();

console.log(
  "PATCH_VERSION",
  "github_clean_server_whatsapp_template_v4_whatsapp_no_extra_contact"
);
console.log("ANA_PROMPT_ACTIVE:", SYSTEM_PROMPT.slice(0, 250));

function val(value, fallback = "") {
  const clean =
    value === undefined || value === null ? "" : String(value).trim();
  return clean || fallback;
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function hasVehicleServiceIntent(conversation) {
  const text = normalizeText(
    conversation
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
  );

  return /(grua|grúa|remolque|remolcar|traslado|trasladar|llevar|choque|accidente|varado|bateria|batería|llanta|no prende|se apago|se apagó|auxilio|carro|auto|vehiculo|vehículo|camioneta|maquinaria)/i.test(
    text
  );
}

function hasUnsupportedObjectIntent(conversation) {
  const text = normalizeText(
    conversation
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
  );

  return /(nevera|refrigeradora|mueble|muebles|cama|sofa|sofá|mercancia|mercancía|material|materiales|caja|cajas|equipo|electrodomestico|electrodoméstico|lavadora|secadora|televisor|mudanza|paquete|bultos|contenedor|contenedores)/i.test(
    text
  );
}

function responseIsFinal(response) {
  const text = normalizeText(response);
  const hasQuestion = response.includes("?") || response.includes("¿");

  const finalPhrase =
    text.includes("ya tengo la informacion") ||
    text.includes("le van a devolver la llamada") ||
    text.includes("le pueden devolver la llamada") ||
    text.includes("voy a pasar su solicitud") ||
    text.includes("gracias por comunicarse") ||
    text.includes("para confirmarle");

  return finalPhrase && !hasQuestion;
}

async function getCallInfo(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token || !callSid) {
    console.log("CALL_INFO_MISSING_DATA");
    return {};
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`,
      {
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        },
      }
    );

    if (!response.ok) {
      console.log("CALL_INFO_STATUS", response.status, await response.text());
      return {};
    }

    return await response.json();
  } catch (error) {
    console.error("CALL_INFO_ERROR", error);
    return {};
  }
}

async function hangupCall(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token || !callSid) {
    console.log("HANGUP_MISSING_DATA");
    return;
  }

  try {
    const form = new URLSearchParams({
      Status: "completed",
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      }
    );

    console.log("HANGUP_STATUS", response.status, await response.text());
  } catch (error) {
    console.error("HANGUP_ERROR", error);
  }
}

async function aiResponse(conversation, channel = "voice") {
  const transcript = conversation
    .map((m) => `${m.role === "assistant" ? "Ana" : "Cliente"}: ${m.content}`)
    .join("\n");

  const prompt =
    SYSTEM_PROMPT +
    "\n\nCONVERSACION:\n" +
    transcript +
    "\n\nResponde ahora como Ana. Reglas críticas:" +
    (channel === "whatsapp"
      ? "\n- Estás respondiendo por WhatsApp escrito, no por llamada de voz." +
        "\n- No preguntes por WhatsApp, teléfono ni contacto adicional. El cliente ya está escribiendo por WhatsApp y ese número se usa como contacto." +
        "\n- Considera el contacto como resuelto automáticamente en conversaciones por WhatsApp escrito." +
        "\n- Si ya tienes ubicación, destino, punto de referencia, modelo y nombre, cierra con una frase corta y no sigas preguntando contacto."
      : "") +
    "\n- Responde corto, natural y rápido." +
    "\n- Si el cliente pregunta tu nombre, responde exactamente: Me llamo Ana." +
    "\n- Si el cliente hace una pregunta en vez de responder el dato que pediste, responde primero su pregunta de forma breve y natural." +
    "\n- Después de responder una pregunta del cliente, vuelve una sola vez al dato pendiente, sin repetir la misma frase exacta." +
    "\n- No repitas la misma pregunta más de una vez seguida." +
    "\n- Si el cliente evita responder o cambia de tema varias veces, cierra diciendo exactamente: Okay, le van a devolver la llamada en un minuto para la cotización." +
    "\n- Cuando cierres con esa frase, no hagas más preguntas." +
    "\n- No uses la palabra entendido. Usa Okay." +
    "\n- No repitas preguntas ya respondidas." +
    "\n- Haz una sola pregunta por turno." +
    "\n- Si el cliente pide trasladar algo que no sea auto, camioneta o maquinaria, NO pidas ubicación ni destino." +
    "\n- Para objetos no permitidos, responde que solo hacemos grúas para autos, camionetas y maquinarias, y pide solo WhatsApp o teléfono." +
    "\n- Cuando ya tengas los datos o debas cerrar, di una frase final corta y no sigas preguntando.";

  const response = await openai.responses.create({
    model: MODEL,
    input: prompt,
  });

  return response.output_text || "";
}

async function extractServiceData(callSid, conversation) {
  const call = await getCallInfo(callSid);

  const transcript = conversation
    .map((m) => `${m.role === "assistant" ? "Ana" : "Cliente"}: ${m.content}`)
    .join("\n");

  const prompt =
    "Extrae datos de esta llamada de servicios de grúas en Panamá.\n" +
    "Devuelve SOLO JSON válido, sin markdown.\n\n" +
    "Campos exactos:\n" +
    "solicitante, modelo, ubicacion, punto_referencia, destino, telefono, contacto_resuelto, ready, faltantes, servicio_permitido, tipo_no_permitido.\n\n" +
    "Reglas:\n" +
    "- Esta conversación es una llamada de voz.\n" +
    "- ready debe ser true SOLO si el servicio es para auto, camioneta o maquinaria y están: solicitante, modelo, ubicacion, punto_referencia, destino y contacto_resuelto.\n" +
    "- contacto_resuelto es true si el cliente dio WhatsApp/teléfono, dijo que no tiene WhatsApp, dijo que no quiere darlo, dijo que no sabe, o pidió que lo llamen al número desde donde llama.\n" +
    "- Si el cliente dice que lo llamen al mismo número, telefono puede ser vacío, pero contacto_resuelto debe ser true.\n" +
    "- Si el cliente pide trasladar nevera, mueble, mercancía, materiales, cajas, electrodomésticos u objetos que no son auto, camioneta o maquinaria, servicio_permitido debe ser false y ready debe ser false.\n" +
    "- No inventes datos.\n" +
    "- No uses CLIENTE como solicitante.\n" +
    "- Si falta algo obligatorio, ready debe ser false y faltantes debe listar solo lo que falta entre: SOLICITANTE, MODELO, UBICACION, PUNTO_REFERENCIA, DESTINO, RESPUESTA_CONTACTO.\n\n" +
    "CALL INFO:\n" +
    JSON.stringify({
      from: call.from || "",
      to: call.to || "",
      status: call.status || "",
      duration: call.duration || "",
    }) +
    "\n\nTRANSCRIPCION:\n" +
    transcript;

  const response = await openai.responses.create({
    model: MODEL,
    input: prompt,
  });

  const raw = response.output_text || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start < 0 || end < 0) {
    console.log("DATA_PARSE_ERROR", raw);
    return {
      ready: false,
      data: {},
      call,
    };
  }

  let data = {};

  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    console.log("DATA_JSON_PARSE_ERROR", raw);
    return {
      ready: false,
      data: {},
      call,
    };
  }

  const ready =
    data.servicio_permitido !== false &&
    data.solicitante &&
    data.modelo &&
    data.ubicacion &&
    data.punto_referencia &&
    data.destino &&
    data.contacto_resuelto === true &&
    String(data.solicitante).toUpperCase() !== "CLIENTE";

  data.ready = Boolean(ready);

  console.log(
    "DATA_CHECK",
    JSON.stringify({
      ready: data.ready,
      solicitante: data.solicitante || "",
      modelo: data.modelo || "",
      ubicacion: data.ubicacion || "",
      punto_referencia: data.punto_referencia || "",
      destino: data.destino || "",
      telefono: data.telefono || "",
      contacto_resuelto: data.contacto_resuelto || false,
      servicio_permitido: data.servicio_permitido,
      tipo_no_permitido: data.tipo_no_permitido || "",
      faltantes: data.faltantes || [],
    })
  );

  return {
    ready: data.ready,
    data,
    call,
  };
}

async function extractWhatsAppServiceData(from, to, conversation) {
  const transcript = conversation
    .map((m) => `${m.role === "assistant" ? "Ana" : "Cliente"}: ${m.content}`)
    .join("\n");

  const prompt =
    "Extrae datos de esta conversación de WhatsApp de servicios de grúas en Panamá.\n" +
    "Devuelve SOLO JSON válido, sin markdown.\n\n" +
    "Campos exactos:\n" +
    "solicitante, modelo, ubicacion, punto_referencia, destino, telefono, contacto_resuelto, ready, faltantes, servicio_permitido, tipo_no_permitido.\n\n" +
    "Reglas:\n" +
    "- Esta conversación es por WhatsApp escrito.\n" +
    "- El cliente ya está escribiendo por WhatsApp, por eso contacto_resuelto debe ser true automáticamente.\n" +
    "- No exijas otro número de contacto.\n" +
    "- Si el cliente voluntariamente da otro número, colócalo en telefono. Si no da otro número, deja telefono vacío.\n" +
    "- ready debe ser true SOLO si el servicio es para auto, camioneta o maquinaria y están: solicitante, modelo, ubicacion, punto_referencia y destino.\n" +
    "- Si el cliente pide trasladar nevera, mueble, mercancía, materiales, cajas, electrodomésticos u objetos que no son auto, camioneta o maquinaria, servicio_permitido debe ser false y ready debe ser false.\n" +
    "- No inventes datos.\n" +
    "- No uses CLIENTE como solicitante.\n" +
    "- Si falta algo obligatorio, ready debe ser false y faltantes debe listar solo lo que falta entre: SOLICITANTE, MODELO, UBICACION, PUNTO_REFERENCIA, DESTINO.\n\n" +
    "INFO WHATSAPP:\n" +
    JSON.stringify({
      from: from || "",
      to: to || "",
    }) +
    "\n\nCONVERSACION:\n" +
    transcript;

  const response = await openai.responses.create({
    model: MODEL,
    input: prompt,
  });

  const raw = response.output_text || "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start < 0 || end < 0) {
    console.log("WA_DATA_PARSE_ERROR", raw);
    return {
      ready: false,
      data: {},
      call: { from, to },
    };
  }

  let data = {};

  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    console.log("WA_DATA_JSON_PARSE_ERROR", raw);
    return {
      ready: false,
      data: {},
      call: { from, to },
    };
  }

  data.contacto_resuelto = true;

  const ready =
    data.servicio_permitido !== false &&
    data.solicitante &&
    data.modelo &&
    data.ubicacion &&
    data.punto_referencia &&
    data.destino &&
    String(data.solicitante).toUpperCase() !== "CLIENTE";

  data.ready = Boolean(ready);

  console.log(
    "WA_DATA_CHECK",
    JSON.stringify({
      ready: data.ready,
      solicitante: data.solicitante || "",
      modelo: data.modelo || "",
      ubicacion: data.ubicacion || "",
      punto_referencia: data.punto_referencia || "",
      destino: data.destino || "",
      telefono: data.telefono || "",
      contacto_resuelto: data.contacto_resuelto || false,
      servicio_permitido: data.servicio_permitido,
      tipo_no_permitido: data.tipo_no_permitido || "",
      faltantes: data.faltantes || [],
    })
  );

  return {
    ready: data.ready,
    data,
    call: { from, to },
  };
}

async function sendWhatsAppSummary(
  callSid,
  data = {},
  call = {},
  incomplete = false
) {
  console.log("TRY_SEND_WHATSAPP", callSid, "incomplete:", incomplete);

  if (!callSid) {
    console.log("NO_CALL_SID");
    return;
  }

  if (notifiedCalls.has(callSid)) {
    console.log("WHATSAPP_ALREADY_SENT", callSid);
    return;
  }

  notifiedCalls.add(callSid);

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.WHATSAPP_FROM;
  const to = process.env.WHATSAPP_TO;
  const contentSid = process.env.WHATSAPP_CONTENT_SID;

  if (!sid || !token || !from || !to) {
    console.log("WHATSAPP_ENV_MISSING");
    return;
  }

  const callerNumber = val(call.from, "No disponible");
  const calledLine = val(call.to, "No disponible");

  const variables = {
    "1": val(data.solicitante, "No indicado"),
    "2": val(data.ubicacion, "No indicado"),
    "3": val(data.punto_referencia, "No indicado"),
    "4": val(data.destino, "No indicado"),
    "5": val(data.modelo, "No indicado"),
    "6": val(data.telefono, callerNumber),
    "7": callerNumber,
    "8": calledLine,
  };

  let body =
    "🚨 NUEVO SERVICIO\n\n" +
    (incomplete
      ? "⚠️ NOTA: SOLICITUD INCOMPLETA. El cliente no completó todos los datos.\n\n"
      : "") +
    "SOLICITANTE:\n" +
    variables["1"] +
    "\n\nUBICACIÓN:\n" +
    variables["2"] +
    "\n\nPUNTO DE REFERENCIA:\n" +
    variables["3"] +
    "\n\nDESTINO:\n" +
    variables["4"] +
    "\n\nMODELO:\n" +
    variables["5"] +
    "\n\nTeléfono / WhatsApp:\n" +
    variables["6"] +
    "\n\nNúmero que llamó:\n" +
    variables["7"] +
    "\n\nLínea llamada:\n" +
    variables["8"] +
    "\n\nLlamar al cliente lo antes posible.";

  if (data.servicio_permitido === false || data.tipo_no_permitido) {
    body =
      "🚨 NUEVA CONSULTA\n\n" +
      "⚠️ SERVICIO NO CONFIRMADO / FUERA DE CATEGORÍA.\n\n" +
      "Tipo solicitado:\n" +
      val(data.tipo_no_permitido, "Objeto no permitido") +
      "\n\nTeléfono / WhatsApp:\n" +
      variables["6"] +
      "\n\nNúmero que llamó:\n" +
      variables["7"] +
      "\n\nLínea llamada:\n" +
      variables["8"] +
      "\n\nLlamar al cliente lo antes posible.";
  }

  const form = new URLSearchParams({
    From: from,
    To: to,
  });

  if (contentSid) {
    form.append("ContentSid", contentSid);
    form.append("ContentVariables", JSON.stringify(variables));
    console.log(
      "WHATSAPP_USING_TEMPLATE",
      contentSid,
      JSON.stringify(variables)
    );
  } else {
    form.append("Body", body);
    console.log("WHATSAPP_USING_BODY_FALLBACK");
  }

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      }
    );

    const text = await response.text();
    console.log("WHATSAPP_NOTIFY_STATUS", response.status, text);

    if (response.status >= 200 && response.status < 300) {
      try {
        const contactOnlyText = `CONTACTO ADICIONAL DEL CLIENTE: ${variables["6"]}`;

        const contactOnlyForm = new URLSearchParams({
          From: from,
          To: to,
          Body: contactOnlyText,
        });

        const contactOnlyResponse = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization:
                "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: contactOnlyForm,
          }
        );

        console.log(
          "WHATSAPP_CONTACT_ONLY_STATUS",
          contactOnlyResponse.status,
          await contactOnlyResponse.text()
        );
      } catch (error) {
        console.error("WHATSAPP_CONTACT_ONLY_ERROR", error);
      }

      if (!String(callSid).startsWith("wa:")) {
        console.log("SCHEDULE_HANGUP_AFTER_WHATSAPP");
        setTimeout(() => hangupCall(callSid), 5000);
      }
    }
  } catch (error) {
    console.error("WHATSAPP_NOTIFY_ERROR", error);
  }
}

fastify.get("/", async () => {
  return {
    ok: true,
    service: "ana-200gruas",
    ws: "/ws",
    version: "github_clean_server_whatsapp_template_v3_whatsapp_contact_auto",
  };
});

fastify.all("/whatsapp", async (request, reply) => {
  const from = request.body?.From || "";
  const to = request.body?.To || "";
  const body = request.body?.Body || "";

  console.log(
    "WHATSAPP_INBOUND",
    JSON.stringify({
      from,
      to,
      body,
    })
  );

  const conversationKey = `wa:${from}`;
  const conversation = sessions.get(conversationKey) || [];

  conversation.push({
    role: "user",
    content: body,
  });

  let responseText = "";

  try {
    responseText = await aiResponse(conversation, "whatsapp");
  } catch (error) {
    console.error("WHATSAPP_AI_ERROR", error);
    responseText =
      "Okay, recibí su mensaje. ¿Me indica la ubicación de origen y hacia dónde habría que llevar el vehículo?";
  }

  conversation.push({
    role: "assistant",
    content: responseText,
  });

  sessions.set(conversationKey, conversation);

  try {
    const check = await extractWhatsAppServiceData(from, to, conversation);

    if (check.ready && !notifiedCalls.has(conversationKey)) {
      await sendWhatsAppSummary(conversationKey, check.data, check.call, false);
      sessions.delete(conversationKey);
      setTimeout(() => notifiedCalls.delete(conversationKey), 10 * 60 * 1000);
    }
  } catch (error) {
    console.error("WHATSAPP_EXTRACT_OR_NOTIFY_ERROR", error);
  }

  const safeResponse = String(responseText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

  reply.type("text/xml").send(`
<Response>
  <Message>${safeResponse}</Message>
</Response>`);
});

fastify.all("/twiml", async (request, reply) => {
  reply.type("text/xml").send(`
<Response>
  <Connect>
    <ConversationRelay url="${WS_URL}" welcomeGreeting="${WELCOME_GREETING}" />
  </Connect>
</Response>`);
});

fastify.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (ws) => {
    ws.on("message", async (data) => {
      let message;

      try {
        message = JSON.parse(data);
      } catch (error) {
        console.error("WS_JSON_PARSE_ERROR", error);
        return;
      }

      switch (message.type) {
        case "setup": {
          const callSid = message.callSid;
          console.log("Setup for call:", callSid);

          ws.callSid = callSid;
          sessions.set(callSid, []);
          break;
        }

        case "prompt": {
          const callSid = ws.callSid;
          const userText = message.voicePrompt || message.prompt || "";

          console.log("Processing prompt:", userText);

          if (callSid && closingCalls.has(callSid)) {
            console.log("PROMPT_IGNORED_AFTER_CLOSE", callSid);
            return;
          }

          if (!callSid) {
            console.log("PROMPT_WITHOUT_CALLSID");
            return;
          }

          const conversation = sessions.get(callSid) || [];

          conversation.push({
            role: "user",
            content: userText,
          });

          const response = await aiResponse(conversation);

          conversation.push({
            role: "assistant",
            content: response,
          });

          sessions.set(callSid, conversation);

          ws.send(
            JSON.stringify({
              type: "text",
              token: response,
              last: true,
            })
          );

          console.log("Sent response:", response);

          const check = await extractServiceData(callSid, conversation);

          if (check.ready) {
            await sendWhatsAppSummary(callSid, check.data, check.call, false);
            closingCalls.add(callSid);
            return;
          }

          if (responseIsFinal(response)) {
            await sendWhatsAppSummary(callSid, check.data, check.call, true);
            closingCalls.add(callSid);
            return;
          }

          if (
            hasUnsupportedObjectIntent(conversation) &&
            check.data.contacto_resuelto === true
          ) {
            await sendWhatsAppSummary(callSid, check.data, check.call, true);
            closingCalls.add(callSid);
            return;
          }

          break;
        }

        case "interrupt": {
          console.log("Handling interruption.");
          break;
        }

        default: {
          console.warn("Unknown message type received:", message.type);
          break;
        }
      }
    });

    ws.on("close", async () => {
      console.log("WebSocket connection closed");

      const callSid = ws.callSid;
      const conversation = sessions.get(callSid) || [];

      if (callSid && notifiedCalls.has(callSid)) {
        console.log("CALL_CLOSED_AFTER_WHATSAPP_SENT", callSid);
        sessions.delete(callSid);
        closingCalls.delete(callSid);
        return;
      }

      if (callSid) {
        try {
          let check = {
            data: {},
            call: {},
          };

          if (conversation.length > 0) {
            check = await extractServiceData(callSid, conversation);
          } else {
            check.call = await getCallInfo(callSid);
          }

          await sendWhatsAppSummary(
            callSid,
            check.data || {},
            check.call || {},
            true
          );
        } catch (error) {
          console.error("CLOSE_ANYTIME_INCOMPLETE_SEND_ERROR", error);
        }
      }

      if (callSid) {
        sessions.delete(callSid);
        closingCalls.delete(callSid);
      }
    });
  });
});

try {
  await fastify.listen({
    port: PORT,
    host: "0.0.0.0",
  });

  console.log(`Server running at http://localhost:${PORT} and ${WS_URL}`);
} catch (error) {
  fastify.log.error(error);
  process.exit(1);
}
