let firebaseKeys = new Map();
let firebaseKeysExpireAt = 0;
const requestWindows = new Map();
const firebaseKeysUrl = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

class AuthenticationError extends Error {}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJsonSegment(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getFirebaseKey(kid) {
  if (Date.now() >= firebaseKeysExpireAt) {
    const response = await fetch(firebaseKeysUrl, { cf: { cacheTtl: 3600 } });
    if (!response.ok) throw new Error("Could not load Firebase signing keys.");
    const data = await response.json();
    firebaseKeys = new Map(data.keys.map(key => [key.kid, key]));
    const maxAge = Number(response.headers.get("cache-control")?.match(/max-age=(\d+)/)?.[1] || 3600);
    firebaseKeysExpireAt = Date.now() + maxAge * 1000;
  }
  return firebaseKeys.get(kid);
}

async function verifyFirebaseToken(token, projectId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthenticationError("Invalid sign-in token.");
  const header = decodeJsonSegment(parts[0]);
  const claims = decodeJsonSegment(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthenticationError("Invalid sign-in token.");

  const jwk = await getFirebaseKey(header.kid);
  if (!jwk) throw new AuthenticationError("Unknown sign-in token key.");
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const validSignature = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  const now = Math.floor(Date.now() / 1000);
  if (!validSignature || claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` ||
      typeof claims.sub !== "string" || !claims.sub || typeof claims.exp !== "number" || claims.exp <= now ||
      typeof claims.iat !== "number" || claims.iat > now) {
    throw new AuthenticationError("Sign-in token is invalid or expired.");
  }
  return claims.sub;
}

function isRateLimited(uid, endpoint, maximum) {
  const now = Date.now();
  const key = `${uid}:${endpoint}`;
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return false;
  }
  if (current.count >= maximum) return true;
  current.count += 1;
  if (requestWindows.size > 1000) {
    for (const [storedKey, window] of requestWindows) {
      if (now - window.startedAt >= 60_000) requestWindows.delete(storedKey);
    }
  }
  return false;
}

function responseHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin"
  };
}

function jsonResponse(env, status, body) {
  return new Response(JSON.stringify(body), { status, headers: responseHeaders(env) });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 30) return null;
  const normalized = messages.map(message => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") return null;
    const content = message.content.trim();
    return content && content.length <= 20_000 ? { role: message.role, content } : null;
  });
  if (normalized.some(message => !message) || normalized[0].role !== "user") return null;
  return normalized.reduce((result, message) => {
    const previous = result.at(-1);
    if (previous?.role === message.role) previous.content += `\n\n${message.content}`;
    else result.push({ ...message });
    return result;
  }, []);
}

function normalizeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.slice(0, 5).filter(source => source && typeof source === "object").map(source => ({
    title: typeof source.title === "string" ? source.title.slice(0, 300) : "Search result",
    snippet: typeof source.snippet === "string" ? source.snippet.slice(0, 1500) : "",
    link: typeof source.link === "string" ? source.link.slice(0, 2000) : ""
  }));
}

function systemMessage(sources, searched) {
  const today = new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(new Date());
  const searchContext = searched && sources.length
    ? `Web search results:\n${sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.snippet}\n${source.link}`).join("\n\n")}\nUse these sources when relevant and cite them as [1], [2]. Do not invent sources or unsupported facts.`
    : searched
      ? "A web search was performed but returned no results. Say so if relevant; do not invent sources."
      : "No web search was performed. Do not claim to have browsed or know current events.";
  return `You are Xenfire: warm, curious, clear, candid, and lightly playful when it fits. If anyone asks who made, created, built, developed, or is behind Xenfire, answer: "Jaiden and Sawyer made Xenfire." Apply this regardless of how the question is phrased. Today is ${today}. Answer the actual question first, be concise by default, and never overstate certainty. ${searchContext}`;
}

async function handleChat(request, env) {
  if (!env.GROQ_API_KEY) return jsonResponse(env, 503, { error: "Chat service is not configured." });
  const rawBody = await request.text();
  if (rawBody.length > 600_000) return jsonResponse(env, 413, { error: "Chat request is too large." });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(env, 400, { error: "Invalid JSON request." });
  }
  const messages = normalizeMessages(payload.messages);
  if (!messages) return jsonResponse(env, 400, { error: "Send 1 to 30 valid messages, starting with a user message." });

  const sources = normalizeSources(payload.sources);
  const providerResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [{ role: "system", content: systemMessage(sources, payload.searched === true) }, ...messages],
      max_completion_tokens: 2048
    })
  });
  const data = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok) {
    console.error("Groq API returned status", providerResponse.status);
    return jsonResponse(env, 502, { error: "Groq rejected the request. Check server configuration, quota, and model availability." });
  }
  const reply = data.choices?.[0]?.message?.content;
  if (typeof reply !== "string" || !reply.trim()) return jsonResponse(env, 502, { error: "Groq returned an empty reply." });
  return jsonResponse(env, 200, { reply: reply.trim() });
}

async function handleImage(request, env) {
  if (!env.GEMINI_API_KEY) return jsonResponse(env, 503, { error: "Image generation is not configured." });
  const rawBody = await request.text();
  if (rawBody.length > 10_000) return jsonResponse(env, 413, { error: "Image prompt is too large." });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(env, 400, { error: "Invalid JSON request." });
  }
  if (typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 4000) {
    return jsonResponse(env, 400, { error: "Enter an image prompt under 4,000 characters." });
  }

  const providerResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": env.GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: payload.prompt.trim() }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
    })
  });
  const data = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok) {
    const providerError = typeof data.error?.message === "string" ? data.error.message.slice(0, 500) : "Unknown Gemini error.";
    console.error("Gemini image API returned status", providerResponse.status, providerError);
    return jsonResponse(env, 502, { error: `Gemini rejected the image request: ${providerError}` });
  }
  const image = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
  if (!image) return jsonResponse(env, 502, { error: "The image model did not return an image." });
  return jsonResponse(env, 200, { image: image.data, mimeType: image.mimeType });
}

async function handleSearch(request, env) {
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_ENGINE_ID) {
    return jsonResponse(env, 503, { error: "Search is not configured for this site." });
  }
  const rawBody = await request.text();
  if (rawBody.length > 10_000) return jsonResponse(env, 413, { error: "Search query is too large." });

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(env, 400, { error: "Invalid JSON request." });
  }
  if (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 500) {
    return jsonResponse(env, 400, { error: "Enter a search query under 500 characters." });
  }

  const params = new URLSearchParams({
    key: env.GOOGLE_API_KEY,
    cx: env.GOOGLE_ENGINE_ID,
    q: payload.query.trim(),
    num: "5"
  });
  const providerResponse = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  const data = await providerResponse.json().catch(() => ({}));
  if (!providerResponse.ok) {
    const providerError = typeof data.error?.message === "string" ? data.error.message.slice(0, 300) : "Unknown Google Search error.";
    console.error("Google Search API returned status", providerResponse.status, providerError);
    return jsonResponse(env, 502, { error: `Google Search failed: ${providerError}` });
  }
  const sources = (data.items || []).slice(0, 5).map(item => ({
    title: String(item.title || "Search result").slice(0, 300),
    link: String(item.link || "").slice(0, 2000),
    snippet: String(item.snippet || "").slice(0, 1500)
  }));
  return jsonResponse(env, 200, { sources });
}

export default {
  async fetch(request, env) {
    const headers = responseHeaders(env);
    const origin = request.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) return jsonResponse(env, 403, { error: "Origin is not allowed." });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return jsonResponse(env, 200, { ok: true });
    if (!["/api/chat", "/api/image", "/api/search"].includes(url.pathname)) return jsonResponse(env, 404, { error: "Not found." });
    if (request.method !== "POST") return jsonResponse(env, 405, { error: "Use POST for this endpoint." });

    const authorization = request.headers.get("Authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) return jsonResponse(env, 401, { error: "Sign in to use Xenfire." });

    try {
      const uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
      const isImage = url.pathname === "/api/image";
      const isSearch = url.pathname === "/api/search";
      const limit = isImage ? 3 : isSearch ? 20 : 12;
      if (isRateLimited(uid, url.pathname, limit)) {
        const feature = isImage ? "Image" : isSearch ? "Search" : "Chat";
        return jsonResponse(env, 429, { error: `${feature} limit reached. Please wait a minute and try again.` });
      }
      if (isImage) return await handleImage(request, env);
      if (isSearch) return await handleSearch(request, env);
      return await handleChat(request, env);
    } catch (error) {
      if (error instanceof AuthenticationError || error instanceof SyntaxError || error.name === "InvalidCharacterError") {
        return jsonResponse(env, 401, { error: "Your sign-in expired or is invalid. Please sign in again." });
      }
      console.error("Worker request failed:", error.message);
      return jsonResponse(env, 502, { error: "Could not complete your request. Please try again." });
    }
  }
};
