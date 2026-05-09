import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyFormbody from "@fastify/formbody";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.RENDER_EXTERNAL_URL || "https://ana-200gruas.onrender.com";
const WS_URL = `wss://${DOMAIN.replace(/^https?:\/\//, "")}/ws`;

const MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

const SYSTEM_PROMPT =
  process.env.ANA_SYSTEM_PROMPT ||
  "Eres Ana, operadora telefónica profesional de servicios de grúas en Panamá.";

const WELCOME_GREETING =
  process.env.WELCOME_GREETING ||
  "Buenas, servicio de grúas a la orden.";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const fastify = Fastify({ logger: false });

fastify.register(fastifyWebsocket);
fastify.register(fastifyFormbody);

const sessions = new Map();
const notifiedCalls = new Set();

console.log("PATCH_VERSION", "github_clean_server_whatsapp_template_v1");
console.log("ANA_PROMPT_ACTIVE:", SYSTEM_PROMPT.slice(0, 200));

function valueOr(value, fallback) {
  const clean = value === undefined || value === null ? "" : String(value).trim();
  return clean || fallback;
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hasTowServiceIntent(conversation) {
  const text = normalizeText(
    conversation
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join(" ")
  );

  return /(grua|servicio|remolque|traslado|choque|accidente|bateria|llanta|varado|no prende|se apago|averia|auxilio)/i.test(
    text
  );
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

async function aiResponse(conversation) {
  const transcript = conversation
    .map((m) => `${m.role === "assistant" ? "Ana" : "Cliente"}: ${m.content}`)
    .join("\n");

  const response = await openai.responses.create({
    model: MODEL,
    input:
      SYSTEM_PROMPT +
      "\n\nCONVERSACION:\n" +
      transcript +
      "\n\nResponde ahora como Ana. Sigue estrictamente las instrucciones anteriores. " +
      "Habla natural, breve y como operadora telefónica. " +
      "No digas la hora salvo que el cliente la pregunte. " +
      "No respondas como asistente genérico. " +
      "La primera pregunta debe pedir ubicación de origen y destino para cotizarle. " +
      "Frase sugerida: ¿Me indica la ubicación de origen y hacia dónde habría que llevar el vehículo para cotizarle? " +
      "Luego pide punto de referencia del origen, modelo, nombre y WhatsApp o teléfono. " +
      "Haz una sola pregunta por turno. " +
      "No pidas año ni color. " +
      "Antes de cerrar, siempre pregunta por WhatsApp o teléfono de contacto y espera la respuesta del cliente. " +
      "Si el cliente no tiene o no quiere darlo, continúa la solicitud. " +
      "Cuando ya tengas ubicación, destino, punto de referencia, modelo, nombre y respuesta del WhatsApp o teléfono, cierra diciendo: Listo, ya tengo la información. Le van a devolver la llamada en un minuto para coordinarle la grúa. " +
      "Si después de 3 intentos reales el cliente no da los datos necesarios o se desvía de la conversación, di exactamente: Entiendo. Para ayudarle mejor, voy a pasar su solicitud al equipo con la información que tengo. Gracias por comunicarse.",
  });

  return response.output_text || "";
}

async function extractServiceData(callSid, conversation) {
  const call = await getCallInfo(callSid);

  const transcript = conversation
    .map((m) => `${m.role === "assistant" ? "Ana" : "Cliente"}: ${m.content}`)
    .join("\n");

  const prompt =
    "Extrae datos de esta llamada de servicios de grúas en Panamá. " +
    "Devuelve SOLO JSON válido, sin markdown. " +
    "Campos exactos: solicitante, modelo, ubicacion, punto_referencia, destino, telefono, contacto_resuelto, ready, faltantes. " +
    "Las preguntas pueden venir en cualquier orden. " +
    "telefono o WhatsApp NO es obligatorio como número, pero sí es obligatorio que Ana lo haya preguntado y que el cliente haya respondido esa pregunta. " +
    "contacto_resuelto debe ser true SOLO si el cliente ya respondió la pregunta del WhatsApp o teléfono: dio un número, dijo que no tiene WhatsApp, dijo que no quiere darlo, dijo que no sabe, o dijo que lo llamen al número desde donde llama. " +
    "NO pongas contacto_resuelto true solo porque Ana preguntó; debe haber respuesta del cliente. " +
    "ready debe ser true SOLO si hay solicitante, modelo, ubicacion, punto_referencia, destino y contacto_resuelto es true. " +
    "Si el cliente dio teléfono o WhatsApp, colócalo en telefono. Si no lo dio, deja telefono vacío. " +
    "No uses el número automático de llamada como telefono si el cliente no lo confirmó. " +
    "ubicacion es el origen donde está el vehículo. " +
    "punto_referencia es un punto de referencia cercano al origen. " +
    "destino es hacia dónde se llevará el vehículo. " +
    "modelo debe ser solamente la marca y/o modelo del vehículo que el cliente indique. NO exijas año. NO exijas color. NO pongas año ni color como faltantes. " +
    "Si falta algo obligatorio, ready debe ser false y faltantes debe listar solo lo que falta entre: SOLICITANTE, MODELO, UBICACION, PUNTO_REFERENCIA, DESTINO, RESPUESTA_CONTACTO. " +
    "Devuelve los textos en MAYÚSCULA, excepto telefono. " +
    "Nunca uses CLIENTE como solicitante. " +
    "Número automático de llamada, solo referencia: " +
    (call.from || "") +
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
    return { ready: false, data: {}, call };
  }

  let data = {};

  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    console.log("DATA_PARSE_ERROR", raw);
    return { ready: false, data: {}, call };
  }

  const contactoOk = !!data.contacto_resuelto || !!data.telefono;

  const ready = !!(
    data.solicitante &&
    data.modelo &&
    data.ubicacion &&
    data.punto_referencia &&
    data.destino &&
    contactoOk &&
    String(data.solicitante).toUpperCase() !== "CLIENTE"
  );

  data.ready = ready;

  console.log(
    "DATA_CHECK",
    JSON.stringify({
      ready,
      solicitante: data.solicitante || "",
      modelo: data.modelo || "",
      ubicacion: data.ubicacion || "",
      punto_referencia: data.punto_referencia || "",
      destino: data.destino || "",
      telefono: data.telefono || "",
      contacto_resuelto: !!data.contacto_resuelto,
      faltantes: data.faltantes || [],
    })
  );

  return { ready, data, call };
}

function shouldSendIncompleteLead(conversation, data) {
  const userTurns = conversation.filter((m) => m.role === "user").length;
  const assistantMessages = conversation
    .filter((m) => m.role === "assistant")
    .map((m) => m.content || "");

  const lastAssistant = normalizeText(
    assistantMessages[assistantMessages.length - 1] || ""
  );

  const finalizoIncompleto =
    lastAssistant.includes(
      "voy a pasar su solicitud al equipo con la informacion que tengo"
    ) ||
    lastAssistant.includes("gracias por comunicarse");

  const trigger = !data.ready && finalizoIncompleto && userTurns >= 3;

  console.log(
    "INCOMPLETE_CHECK",
    JSON.stringify({
      trigger,
      finalizoIncompleto,
      userTurns,
      lastAssistant: lastAssistant.slice(0, 180),
    })
  );

  return trigger;
}

async function sendWhatsAppSummary(callSid, data, call, incomplete = false) {
  console.log("TRY_SEND_WHATSAPP", callSid, "incomplete:", incomplete);

  if (!callSid) {
    console.log("NO_CALL_SID");
    return;
  }

  if (notifiedCalls.has(callSid)) {
    console.log("WHATSAPP_ALREADY_SENT");
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

  const variables = {
    "1": valueOr(data.solicitante, "No indicado"),
    "2": valueOr(data.ubicacion, "No indicado"),
    "3": valueOr(data.punto_referencia, "No indicado"),
    "4": valueOr(data.destino, "No indicado"),
    "5": valueOr(data.modelo, "No indicado"),
    "6": valueOr(data.telefono, " "),
    "7": valueOr(call.from, "No disponible"),
    "8": valueOr(call.to, "No disponible"),
  };

  const body =
    "🚨 NUEVO SERVICIO \n\n" +
    (incomplete
      ? "NOTA:\nSOLICITUD INCOMPLETA. El cliente no completó todos los datos.\n\n"
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
    "\n\n\n\n\nTeléfono / WhatsApp:\n" +
    variables["6"] +
    "\n\nNúmero que llamó:\n" +
    variables["7"] +
    "\n\nLínea llamada:\n" +
    variables["8"] +
    "\n\nLlamar al cliente lo antes posible.";

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

  if (response.status === 201) {
    console.log("SCHEDULE_HANGUP_AFTER_WHATSAPP");
    setTimeout(() => hangupCall(callSid), 6000);
  }
}

fastify.all("/", async () => {
  return {
    ok: true,
    service: "ana-200gruas",
    ws: "/ws",
    version: "github_clean_server_whatsapp_template_v1",
  };
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
          } else if (shouldSendIncompleteLead(conversation, check.data)) {
            await sendWhatsAppSummary(callSid, check.data, check.call, true);
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

      if (callSid && !notifiedCalls.has(callSid)) {
        console.log("CALL_CLOSED_ANYTIME_SEND_INCOMPLETE", callSid);

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
