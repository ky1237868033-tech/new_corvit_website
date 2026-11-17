// Netlify Serverless Function: proxies chat requests to the Dify.ai Chat API.
// The API key is read from the DIFY_API_KEY environment variable and is never exposed to the browser.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
    },
  });

// Dify Cloud's API lives at https://api.dify.ai/v1. If the base URL is set to the
// public Dify domain (the default), map it to the real API endpoint. Self-hosted
// installs should set DIFY_BASE_URL to something like https://your-dify.example.com/v1
const resolveBaseUrl = () => {
  const raw = (process.env.DIFY_BASE_URL || "https://dify.ai").trim().replace(/\/+$/, "");
  if (/^https?:\/\/(www\.|cloud\.)?dify\.ai$/i.test(raw)) {
    return "https://api.dify.ai/v1";
  }
  return raw;
};

const TIMEOUT_MS = Number(process.env.DIFY_TIMEOUT_MS) || 25000;

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed. Please use POST." });
  }

  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) {
    console.error("DIFY_API_KEY is not set in the environment.");
    return json(500, {
      error:
        "The chat service is not configured yet (DIFY_API_KEY is missing on the server). Please contact the site administrator.",
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid request: body must be valid JSON." });
  }

  const query = typeof payload?.query === "string" ? payload.query.trim() : "";
  if (!query) {
    return json(400, { error: "Please type a message before sending." });
  }
  if (query.length > 2000) {
    return json(400, { error: "Your message is too long. Please keep it under 2000 characters." });
  }

  const conversationId =
    typeof payload?.conversation_id === "string" ? payload.conversation_id.trim().slice(0, 128) : "";
  const user =
    (typeof payload?.user === "string" ? payload.user.trim().slice(0, 100) : "") || "corvit-student";

  const url = `${resolveBaseUrl()}/chat-messages`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let difyResponse;
  try {
    difyResponse = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: {},
        query,
        response_mode: "blocking",
        conversation_id: conversationId,
        user,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") {
      return json(504, {
        error: "The AI Advisor took too long to respond. Please try again in a moment.",
      });
    }
    console.error("Failed to reach Dify:", err?.message || err);
    return json(502, {
      error: "Could not reach the AI service right now. Please try again shortly.",
    });
  }
  clearTimeout(timer);

  const rawText = await difyResponse.text();
  let data = null;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = null;
  }

  if (!difyResponse.ok) {
    console.error("Dify error:", difyResponse.status, rawText.slice(0, 500));
    const difyMessage = data?.message || data?.error || "";

    if (difyResponse.status === 401 || difyResponse.status === 403) {
      return json(502, {
        error: "The AI service rejected the server's credentials. Please contact the site administrator.",
        code: data?.code,
      });
    }
    if (difyResponse.status === 404) {
      return json(404, {
        error: difyMessage || "Conversation or AI service endpoint not found.",
        code: data?.code,
      });
    }
    if (difyResponse.status === 429) {
      return json(429, {
        error: "The AI Advisor is receiving many requests. Please wait a few seconds and try again.",
        code: data?.code,
      });
    }
    if (difyResponse.status >= 400 && difyResponse.status < 500) {
      return json(difyResponse.status, {
        error: difyMessage || "The AI service could not process this request.",
        code: data?.code,
      });
    }
    return json(502, {
      error: difyMessage || "The AI service is temporarily unavailable. Please try again later.",
      code: data?.code,
    });
  }

  if (!data || typeof data !== "object") {
    console.error("Unexpected non-JSON response from Dify:", rawText.slice(0, 300));
    return json(502, {
      error:
        "The AI service returned an unexpected response. If this keeps happening, check DIFY_BASE_URL on the server.",
    });
  }

  return json(200, {
    answer: typeof data.answer === "string" ? data.answer : "",
    conversation_id: data.conversation_id || conversationId || "",
    message_id: data.message_id || data.id || "",
  });
};
