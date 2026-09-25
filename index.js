const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

// Set this once with:
//   firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

exports.chatCompletion = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const messages = request.data.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new HttpsError("invalid-argument", "messages must be a non-empty array.");
    }

    // Anthropic expects alternating user/assistant turns with valid roles/content only.
    const cleaned = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map(m => ({ role: m.role, content: m.content }));

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        messages: cleaned
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", errText);
      throw new HttpsError("internal", "The AI provider returned an error.");
    }

    const data = await response.json();
    const reply = (data.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");

    return { reply: reply || "(empty response)" };
  }
);
