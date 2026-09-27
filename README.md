# Xenfire chat

## Hosted app

The hosted site uses Firebase Hosting, Authentication, and Firestore with a
Cloudflare Worker API proxy. Text replies use Groq's GPT-OSS 120B model;
image generation uses Gemini. Provider keys stay in Worker secrets and are
never sent to visitor browsers. Current-date questions use the device clock,
and fresh facts can use the optional Google Search control.

For local development, add `GROQ_API_KEY` and `GEMINI_API_KEY` to the ignored
`.env` file. Search is optional; to enable it, also configure `GOOGLE_API_KEY`
and `GOOGLE_ENGINE_ID` in `.env`. Deploy the Worker with
`npx --yes wrangler deploy --config cloudflare/wrangler.toml`, then set provider
keys as Worker secrets using `npx --yes wrangler secret put KEY --config
cloudflare/wrangler.toml`. Firebase Hosting remains on the Spark plan; provider
usage may incur charges under current provider pricing and quota.

Enable **Authentication > Sign-in method > Email/Password** and create a
Firestore database. Signed-in conversations are stored in Firestore.

The site is deployed at <https://xenfire-ai.web.app>.

To deploy static frontend changes after the Worker is available:

```sh
npx --yes firebase-tools deploy --only hosting --project xenfire-ai
```

## Local preview

The local preview bypasses Firebase sign-in and stores conversations in this
browser. Text replies use the local server's Groq key; image generation uses
the local server's Gemini key.

Run the server with Node.js 20.12 or newer:

```sh
npm start
```

Open <http://localhost:8000/>.
