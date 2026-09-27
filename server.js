const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";
const files = new Map([
  ["/", ["public/dashboard.html", "text/html; charset=utf-8"]],
  ["/dashboard.html", ["public/dashboard.html", "text/html; charset=utf-8"]],
  ["/chat", ["public/index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["public/index.html", "text/html; charset=utf-8"]],
  ["/chat.js", ["public/chat.js", "text/javascript; charset=utf-8"]],
  ["/theme.css", ["public/theme.css", "text/css; charset=utf-8"]],
  ["/dashboard.css", ["public/dashboard.css", "text/css; charset=utf-8"]],
  ["/firebase-config.js", ["public/firebase-config.js", "text/javascript; charset=utf-8"]],
  ["/assets/xenfire-logo.svg", ["public/assets/xenfire-logo.svg", "image/svg+xml"]],
  ["/assets/fire-background.jpg", ["public/assets/fire-background.jpg", "image/jpeg"]]
]);

function sendJson(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request is too large.");
  }
  return JSON.parse(body);
}

async function handleChat(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Use POST to send a chat message." });
    return;
  }
  if (!process.env.GROQ_API_KEY) {
    sendJson(response, 503, { error: "Set GROQ_API_KEY in .env to enable AI replies." });
    return;
  }

  let payload;
  try {
    payload = await readRequestBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message === "Request is too large." ? error.message : "Invalid JSON request." });
    return;
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 30) {
    sendJson(response, 400, { error: "Send between 1 and 30 messages." });
    return;
  }

  let messages = payload.messages.map(message => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") return null;
    const content = message.content.trim();
    return content && content.length <= 20_000 ? { role: message.role, content } : null;
  });
  if (messages.some(message => !message) || messages[0].role !== "user") {
    sendJson(response, 400, { error: "Messages must contain valid user and assistant text, starting with a user message." });
    return;
  }
  messages = messages.reduce((normalized, message) => {
    const previous = normalized.at(-1);
    if (previous && previous.role === message.role) previous.content += `\n\n${message.content}`;
    else normalized.push({ ...message });
    return normalized;
  }, []);

  const sources = Array.isArray(payload.sources)
    ? payload.sources.slice(0, 5).filter(source => source && typeof source === "object").map(source => ({
      title: typeof source.title === "string" ? source.title.slice(0, 300) : "Search result",
      snippet: typeof source.snippet === "string" ? source.snippet.slice(0, 1500) : "",
      link: typeof source.link === "string" ? source.link.slice(0, 2000) : ""
    }))
    : [];
  const searchContext = payload.searched && sources.length
    ? `Web search results:\n${sources.map((source, index) => `[${index + 1}] ${source.title}\n${source.snippet}\n${source.link}`).join("\n\n")}\nUse these sources when relevant and cite them as [1], [2]. Do not invent sources or unsupported facts.`
    : payload.searched
      ? "A web search was performed but returned no results. Say so if relevant; do not invent sources."
      : "No web search was performed. Do not claim to have browsed or know current events.";

  try {
    const providerResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          {
            role: "system",
            content: `You are Xenfire: warm, curious, clear, and candid. If anyone asks who made, created, built, developed, or is behind Xenfire, answer: "Jaiden and Sawyer made Xenfire." Apply this regardless of how the question is phrased. Today is ${new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(new Date())}. Answer the actual question first, be concise by default, and do not claim to browse unless search results are provided. ${searchContext}`
          },
          ...messages
        ],
        max_completion_tokens: 2048
      })
    });

    if (!providerResponse.ok) {
      console.error("Groq API returned status", providerResponse.status);
      sendJson(response, 502, { error: "Groq rejected the request. Check server configuration, quota, and model availability." });
      return;
    }

    const data = await providerResponse.json();
    const reply = data.choices?.[0]?.message?.content;
    sendJson(response, 200, { reply: typeof reply === "string" ? reply : "" });
  } catch (error) {
    console.error("Could not reach Groq:", error.message);
    sendJson(response, 502, { error: "Could not reach Groq. Check the server connection and try again." });
  }
}

async function handleImage(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Use POST to generate an image." });
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    sendJson(response, 503, { error: "Set GEMINI_API_KEY in .env to enable image generation." });
    return;
  }

  let payload;
  try {
    payload = await readRequestBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message === "Request is too large." ? error.message : "Invalid JSON request." });
    return;
  }
  if (typeof payload.prompt !== "string" || !payload.prompt.trim() || payload.prompt.length > 4000) {
    sendJson(response, 400, { error: "Enter an image prompt under 4,000 characters." });
    return;
  }

  try {
    const providerResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: payload.prompt.trim() }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      })
    });
    const data = await providerResponse.json();
    if (!providerResponse.ok) {
      console.error("Gemini image API returned status", providerResponse.status);
      const providerError = typeof data.error?.message === "string" ? data.error.message.slice(0, 500) : "Unknown Gemini error.";
      sendJson(response, 502, { error: `Gemini rejected the image request: ${providerError}` });
      return;
    }
    const image = data.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData;
    if (!image) {
      sendJson(response, 502, { error: "The image model did not return an image." });
      return;
    }
    sendJson(response, 200, { image: image.data, mimeType: image.mimeType });
  } catch (error) {
    console.error("Could not reach Gemini image API:", error.message);
    sendJson(response, 502, { error: "Could not reach Gemini. Check the server connection and try again." });
  }
}

async function handleSearch(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Use POST to search." });
    return;
  }
  if (!process.env.GOOGLE_API_KEY || !process.env.GOOGLE_ENGINE_ID) {
    sendJson(response, 503, { error: "Set GOOGLE_API_KEY and GOOGLE_ENGINE_ID in .env to enable search." });
    return;
  }

  let payload;
  try {
    payload = await readRequestBody(request);
  } catch (error) {
    sendJson(response, 400, { error: error.message === "Request is too large." ? error.message : "Invalid JSON request." });
    return;
  }
  if (typeof payload.query !== "string" || !payload.query.trim() || payload.query.length > 500) {
    sendJson(response, 400, { error: "Enter a search query under 500 characters." });
    return;
  }

  const params = new URLSearchParams({
    key: process.env.GOOGLE_API_KEY,
    cx: process.env.GOOGLE_ENGINE_ID,
    q: payload.query.trim(),
    num: "5"
  });
  try {
    const providerResponse = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
    const data = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) {
      const providerError = typeof data.error?.message === "string" ? data.error.message.slice(0, 300) : "Unknown Google Search error.";
      console.error("Google Search API returned status", providerResponse.status, providerError);
      sendJson(response, 502, { error: `Google Search failed: ${providerError}` });
      return;
    }
    const sources = (data.items || []).slice(0, 5).map(item => ({
      title: String(item.title || "Search result").slice(0, 300),
      link: String(item.link || "").slice(0, 2000),
      snippet: String(item.snippet || "").slice(0, 1500)
    }));
    sendJson(response, 200, { sources });
  } catch (error) {
    console.error("Could not reach Google Search:", error.message);
    sendJson(response, 502, { error: "Could not reach Google Search. Check the server connection and try again." });
  }
}

createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === "/api/chat") {
    await handleChat(request, response);
    return;
  }
  if (pathname === "/api/image") {
    await handleImage(request, response);
    return;
  }
  if (pathname === "/api/search") {
    await handleSearch(request, response);
    return;
  }

  const file = files.get(pathname);
  if (!file) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  try {
    const content = await readFile(path.join(process.cwd(), file[0]));
    response.writeHead(200, { "Content-Type": file[1], "X-Content-Type-Options": "nosniff" });
    response.end(content);
  } catch {
    response.writeHead(500);
    response.end("Could not load the requested file.");
  }
}).listen(port, host, () => {
  console.log(`Xenfire local server running at http://localhost:${port}`);
});