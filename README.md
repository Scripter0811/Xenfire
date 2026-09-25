# Your chat app

A Claude-style chat UI (sidebar, conversations, message thread) that runs entirely on
Firebase: Hosting for the frontend, Auth for login, Firestore for conversation
history, and one Cloud Function that calls the AI model so your API key never
reaches the browser.

## What "no usage limit" means here

There is no artificial message cap, conversation cap, or rate limiter written into
this code — your users (just you, presumably) can chat as much as you like. Two
real-world ceilings still exist and are outside my control:

1. **Your AI provider's own limits/policies.** The Cloud Function calls the
   Anthropic API with your key. Anthropic's usage policies and the model's own
   behavior still apply — I'm not going to wire in a prompt designed to strip a
   model's safety behavior, and you shouldn't try to either; it'll just get your
   key flagged.
2. **Your Firebase bill.** Cloud Functions that make outbound network calls
   require the **Blaze (pay-as-you-go)** plan. Firestore/Hosting/Functions all
   have a generous free tier, then you pay standard usage rates. There's no
   Firebase-side cap unless you set a budget alert yourself.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project**.
2. In the new project, upgrade to the **Blaze plan** (Settings → Usage and
   billing) — required for the Cloud Function to reach an external API.
3. **Build → Authentication → Get started → Email/Password** → enable it.
4. **Build → Firestore Database → Create database** → start in production mode.
5. **Project settings → General → Your apps → Add app → Web (`</>`)** → register
   an app (no hosting setup needed here) → copy the `firebaseConfig` object.

## 2. Fill in your config

Paste the values you copied into `public/firebase-config.js`.

## 3. Get an Anthropic API key

Create one at https://console.anthropic.com/settings/keys. This is billed
separately from Firebase and is what actually powers the AI replies.

## 4. Install the CLI and deploy

```bash
npm install -g firebase-tools
firebase login

cd chatapp
firebase use --add          # pick your project, alias "default"

# store your AI key as a server-side secret (never exposed to the browser)
firebase functions:secrets:set ANTHROPIC_API_KEY

firebase deploy
```

That deploys Hosting, the Cloud Function, and your Firestore rules together.
Firebase will print your live URL, something like `https://your-project.web.app`.

## 5. Use it

Open the URL, create an account (email/password), and start chatting. Every
conversation is saved per-user in Firestore and shows up in the sidebar; click
"New chat" to start another thread, click the `×` on a sidebar item to delete it.

## Changing the model

`functions/index.js` currently calls Anthropic's `claude-sonnet-4-6`. To use a
different Anthropic model, change the `model` string there. To use a different
provider entirely (OpenAI, etc.), swap the `fetch` call in that same function —
everything else (auth, storage, UI) stays the same.

## Local testing before deploying

```bash
firebase emulators:start
```

This runs Hosting/Auth/Firestore/Functions locally so you can test without
deploying each change.
