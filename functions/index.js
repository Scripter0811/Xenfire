const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

initializeApp();

const GROQ_API_KEY = defineSecret("GROQ_API_KEY");
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const model = "llama-3.3-70b-versatile";

async function consumeRateLimit(uid, maximum) {
  const database = getFirestore();
  const reference = database.collection("_apiRateLimits").doc(uid);
  const now = Date.now();
  return database.runTransaction(async transaction => {
    const snapshot = await transaction.get(reference);
    const current = snapshot.data();
    if (!current || now - current.windowStartedAt >= 60_000) {
      transaction.set(reference, { windowStartedAt: now, count: 1 });
      return true;
    }
    if (current.count >= maximum) return false;
    transaction.update(reference, { count: FieldValue.increment(1) });
    return true;
  });
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

exports.chatCompletion = onRequest({ secrets: [GROQ_API_KEY], region: "us-central1" }, async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.status(405).json({ error: "Use POST to send a chat message." });
    return;
  }

  try {
    const authorization = request.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) {
      response.status(401).json({ error: "Sign in to use chat." });
      return;
    }
    const user = await getAuth().verifyIdToken(token);
    if (!await consumeRateLimit(user.uid, 12)) {
      response.status(429).json({ error: "Chat limit reached. Please wait a minute and try again." });
      return;
    }

    const messages = normalizeMessages(request.body?.messages);
    if (!messages) {
      response.status(400).json({ error: "Send 1 to 30 valid messages, starting with a user message." });
      return;
    }
    const sources = normalizeSources(request.body?.sources);
    const providerResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY.value()}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemMessage(sources, request.body?.searched === true) }, ...messages],
        max_tokens: 2048
      })
    });

    const data = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) {
      console.error("Groq API returned status", providerResponse.status);
      response.status(502).json({ error: "Groq rejected the request. Check server configuration, quota, and model availability." });
      return;
    }
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      response.status(502).json({ error: "Groq returned an empty reply." });
      return;
    }
    response.status(200).json({ reply: reply.trim() });
  } catch (error) {
    if (error.code?.startsWith("auth/")) {
      response.status(401).json({ error: "Your sign-in expired. Please sign in again." });
      return;
    }
    console.error("Chat request failed:", error.message);
    response.status(502).json({ error: "Could not complete the chat request. Please try again." });
  }
});

exports.generateImage = onRequest({ secrets: [GEMINI_API_KEY], region: "us-central1" }, async (request, response) => {
  response.set("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.status(405).json({ error: "Use POST to generate an image." });
    return;
  }

  try {
    const authorization = request.get("authorization") || "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!token) {
      response.status(401).json({ error: "Sign in to generate images." });
      return;
    }
    const user = await getAuth().verifyIdToken(token);
    if (!await consumeRateLimit(user.uid, 3)) {
      response.status(429).json({ error: "Image limit reached. Please wait a minute and try again." });
      return;
    }
    const prompt = request.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
      response.status(400).json({ error: "Enter an image prompt under 4,000 characters." });
      return;
    }

    const providerResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY.value()
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt.trim() }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    });
    const data = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) {
      console.error("Gemini image API returned status", providerResponse.status);
      response.status(502).json({ error: "Gemini rejected the image request. Check server configuration, quota, and model access." });
      return;
    }
    const image = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
    if (!image) {
      response.status(502).json({ error: "The image model did not return an image." });
      return;
    }
    response.status(200).json({ image: image.data, mimeType: image.mimeType });
  } catch (error) {
    if (error.code?.startsWith("auth/")) {
      response.status(401).json({ error: "Your sign-in expired. Please sign in again." });
      return;
    }
    console.error("Image request failed:", error.message);
    response.status(502).json({ error: "Could not complete the image request. Please try again." });
  }
});
