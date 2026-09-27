const urlParams = new URLSearchParams(window.location.search);
const localHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const demoMode = urlParams.get("demo") === "1" || (localHost && urlParams.get("firebase") !== "1");
const settingsKey = "xenfire-settings";
const conversationStorageKey = "xenfire-local-conversations";
const responseTokenLimits = { quick: 128, balanced: 256, detailed: 512 };
let currentUser = null;
let currentConvId = null;
let unsubMessages = null;
let unsubConversations = null;
let searchNextMessage = false;
let imageGenerationNextMessage = false;
let localConversations = [];
let remoteConversations = [];
let apiBaseUrl = "";
let authSdk, firestoreSdk, auth, db;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey) || "{}");
    return {
      theme: ["violet", "light"].includes(saved.theme) ? saved.theme : "light",
      responseLength: Object.hasOwn(responseTokenLimits, saved.responseLength) ? saved.responseLength : "balanced",
      enterToSend: saved.enterToSend !== false,
    };
  } catch {
    return { theme: "light", responseLength: "balanced", enterToSend: true };
  }
}

const settings = loadSettings();

if (!demoMode) {
  const [configModule, appModule, authModule, firestoreModule] = await Promise.all([
    import("./firebase-config.js"),
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js")
  ]);
  apiBaseUrl = configModule.apiBaseUrl;
  authSdk = authModule;
  firestoreSdk = firestoreModule;
  const app = appModule.initializeApp(configModule.firebaseConfig);
  auth = authSdk.getAuth(app);
  db = firestoreSdk.getFirestore(app);
}

const byId = id => document.getElementById(id);
const authScreen = byId("auth-screen");
const appElement = byId("app");
const authEmail = byId("auth-email");
const authPassword = byId("auth-password");
const authError = byId("auth-error");
const emailElement = byId("user-email");
const conversationList = byId("conversation-list");
const messagesElement = byId("messages");
const emptyState = byId("empty-state");
const inputElement = byId("input");
const sendButton = byId("btn-send");
const searchButton = byId("btn-search-toggle");
const imageGenerationButton = byId("btn-image-toggle");
const sidebar = byId("sidebar");
const sidebarScrim = byId("sidebar-scrim");
const settingsDialog = byId("settings-dialog");
const themeSelect = byId("setting-theme");
const responseLengthSelect = byId("setting-response-length");
const enterToSendToggle = byId("setting-enter-to-send");

function persistSettings() {
  document.documentElement.dataset.theme = settings.theme;
  try {
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  } catch {}
}

function showSettings() {
  if (!settingsDialog.open) settingsDialog.showModal();
}

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarScrim.classList.remove("visible");
}

function setSearchMode(enabled) {
  searchNextMessage = enabled;
  searchButton.classList.toggle("active", enabled);
  searchButton.setAttribute("aria-pressed", String(enabled));
  if (enabled) setImageGenerationMode(false);
}

function setImageGenerationMode(enabled) {
  imageGenerationNextMessage = enabled;
  imageGenerationButton.classList.toggle("active", enabled);
  imageGenerationButton.setAttribute("aria-pressed", String(enabled));
}

function bindSettings() {
  themeSelect.value = settings.theme;
  responseLengthSelect.value = settings.responseLength;
  enterToSendToggle.checked = settings.enterToSend;
  persistSettings();

  document.querySelectorAll("[data-open-settings]").forEach(button => button.addEventListener("click", showSettings));
  themeSelect.addEventListener("change", () => {
    settings.theme = themeSelect.value;
    persistSettings();
  });
  responseLengthSelect.addEventListener("change", () => {
    settings.responseLength = responseLengthSelect.value;
    persistSettings();
  });
  enterToSendToggle.addEventListener("change", () => {
    settings.enterToSend = enterToSendToggle.checked;
    persistSettings();
  });
  byId("setting-reset").addEventListener("click", () => {
    Object.assign(settings, {
      theme: "light",
      responseLength: "balanced",
      enterToSend: true
    });
    themeSelect.value = settings.theme;
    responseLengthSelect.value = settings.responseLength;
    enterToSendToggle.checked = settings.enterToSend;
    persistSettings();
  });
  settingsDialog.addEventListener("click", event => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
}

function bindNavigation() {
  byId("btn-mobile-menu").addEventListener("click", () => {
    sidebar.classList.toggle("open");
    sidebarScrim.classList.toggle("visible", sidebar.classList.contains("open"));
  });
  sidebarScrim.addEventListener("click", closeSidebar);
  document.querySelectorAll("[data-prompt]").forEach(button => {
    button.addEventListener("click", () => {
      inputElement.value = button.dataset.prompt;
      sendMessage();
    });
  });
  searchButton.addEventListener("click", () => {
    setSearchMode(!searchNextMessage);
  });
  imageGenerationButton.addEventListener("click", () => {
    setImageGenerationMode(!imageGenerationNextMessage);
    setSearchMode(false);
  });
  byId("btn-new-chat").addEventListener("click", () => startNewChat(true));
  byId("btn-signout").addEventListener("click", () => {
    if (demoMode) window.location.assign(window.location.pathname);
    else authSdk.signOut(auth);
  });
}

function conversationRef() {
  return firestoreSdk.collection(db, "users", currentUser.uid, "conversations");
}

function messageRef(conversationId) {
  return firestoreSdk.collection(db, "users", currentUser.uid, "conversations", conversationId, "messages");
}

function storeLocalConversations() {
  try {
    localStorage.setItem(conversationStorageKey, JSON.stringify(localConversations));
  } catch (error) {
    console.error("Could not save local conversations:", error);
  }
}

function deleteConversation(conversationId) {
  if (demoMode) {
    localConversations = localConversations.filter(conversation => conversation.id !== conversationId);
    storeLocalConversations();
    if (currentConvId === conversationId) startNewChat(false);
    renderConversationList();
  } else {
    firestoreSdk.deleteDoc(firestoreSdk.doc(db, "users", currentUser.uid, "conversations", conversationId));
    if (currentConvId === conversationId) startNewChat(false);
  }
}

function renderConversationList(snapshot = null) {
  conversationList.replaceChildren();
  if (!demoMode && snapshot) {
    remoteConversations = snapshot.docs.map(document => ({ id: document.id, ...document.data() }));
  }
  const conversations = demoMode
    ? [...localConversations].sort((first, second) => second.updatedAt - first.updatedAt)
    : remoteConversations;

  conversations.forEach(conversation => {
    const item = document.createElement("div");
    item.className = `conv-item${conversation.id === currentConvId ? " active" : ""}`;
    const title = document.createElement("button");
    title.className = "conv-title";
    title.type = "button";
    title.textContent = conversation.title || "New conversation";
    title.addEventListener("click", () => openConversation(conversation.id));
    const remove = document.createElement("button");
    remove.className = "conv-delete";
    remove.type = "button";
    remove.title = `Delete ${conversation.title || "conversation"}`;
    remove.setAttribute("aria-label", remove.title);
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteConversation(conversation.id));
    item.append(title, remove);
    conversationList.appendChild(item);
  });
}

function listenConversations() {
  if (unsubConversations) unsubConversations();
  const conversationsQuery = firestoreSdk.query(conversationRef(), firestoreSdk.orderBy("updatedAt", "desc"));
  unsubConversations = firestoreSdk.onSnapshot(conversationsQuery, snapshot => renderConversationList(snapshot), error => {
    showError(error.message);
  });
}

function renderMessage(message) {
  const row = document.createElement("article");
  row.className = `msg-row ${message.role}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = message.content || "";
  row.appendChild(bubble);

  if (typeof message.image === "string" && message.image.startsWith("data:image/jpeg;base64,")) {
    const image = document.createElement("img");
    image.className = "generated-image";
    image.src = message.image;
    image.alt = message.content || "AI-generated image";
    image.loading = "lazy";
    const download = document.createElement("a");
    download.className = "image-download";
    download.href = message.image;
    download.download = "xenfire-generated-image.jpg";
    download.textContent = "Download image";
    row.append(image, download);
  }

  if (Array.isArray(message.sources) && message.sources.length) {
    const sources = document.createElement("div");
    sources.className = "message-sources";
    const label = document.createElement("span");
    label.textContent = "SOURCES";
    sources.appendChild(label);
    message.sources.forEach((source, index) => {
      try {
        const url = new URL(source.link);
        if (!["https:", "http:"].includes(url.protocol)) return;
        const link = document.createElement("a");
        link.href = url.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `${index + 1}. ${source.title || url.hostname}`;
        sources.appendChild(link);
      } catch {}
    });
    if (sources.querySelector("a")) row.appendChild(sources);
  }
  messagesElement.appendChild(row);
}

function scrollToBottom() {
  messagesElement.scrollTop = messagesElement.scrollHeight;
}

function formatCurrentDate() {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date());
}

function answerCurrentDateQuestion(text) {
  if (/\b(?:what\s+(?:is\s+)?(?:the\s+)?(?:current\s+)?date|what\s+day\s+is\s+(?:it|today)|what\s+year\s+is\s+it|what\s+year\s+are\s+we\s+in|today'?s\s+date|current\s+year)\b/i.test(text)) {
    return `Today is ${formatCurrentDate()}.`;
  }
  return null;
}

function renderMessages(messages) {
  messagesElement.replaceChildren();
  if (!messages.length) {
    emptyState.classList.remove("hidden");
    messagesElement.appendChild(emptyState);
    return;
  }
  emptyState.classList.add("hidden");
  messages.forEach(renderMessage);
  scrollToBottom();
}

function startNewChat(focus = false) {
  currentConvId = null;
  if (unsubMessages) {
    unsubMessages();
    unsubMessages = null;
  }
  renderMessages([]);
  renderConversationList();
  closeSidebar();
  if (focus) inputElement.focus();
}

function openConversation(conversationId) {
  currentConvId = conversationId;
  closeSidebar();
  renderConversationList();
  if (demoMode) {
    const conversation = localConversations.find(item => item.id === conversationId);
    renderMessages(conversation?.messages || []);
    return;
  }
  if (unsubMessages) unsubMessages();
  const messagesQuery = firestoreSdk.query(messageRef(conversationId), firestoreSdk.orderBy("createdAt", "asc"));
  unsubMessages = firestoreSdk.onSnapshot(messagesQuery, snapshot => {
    renderMessages(snapshot.docs.map(document => document.data()));
  }, error => showError(error.message));
}

function showError(message) {
  const row = document.createElement("article");
  row.className = "msg-row assistant error";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = message.startsWith("Error:") ? message : `Error: ${message}`;
  row.appendChild(bubble);
  messagesElement.appendChild(row);
  scrollToBottom();
}

async function searchGoogle(queryText) {
  const headers = { "Content-Type": "application/json" };
  if (!demoMode) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Your sign-in expired. Please sign in again.");
    headers.Authorization = `Bearer ${idToken}`;
  }
  const response = await fetch(`${apiBaseUrl || window.location.origin}/api/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: queryText })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Search failed (HTTP ${response.status}).`);
  return Array.isArray(result.sources) ? result.sources : [];
}

async function generateImage(prompt) {
  const headers = { "Content-Type": "application/json" };
  if (!demoMode) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Your sign-in expired. Please sign in again.");
    headers.Authorization = `Bearer ${idToken}`;
  }
  const response = await fetch(`${apiBaseUrl || window.location.origin}/api/image`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt })
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `Image generation failed (HTTP ${response.status}).`);
  }
  if (!result.image) throw new Error("The image model did not return an image. Try a different prompt.");
  return compressGeneratedImage(result.image, result.mimeType);
}

async function compressGeneratedImage(base64, mimeType = "image/png") {
  const source = new Image();
  source.src = `data:${mimeType};base64,${base64}`;
  await source.decode();
  const scale = Math.min(1, 1024 / Math.max(source.naturalWidth, source.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.naturalWidth * scale);
  canvas.height = Math.round(source.naturalHeight * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.82, 0.72, 0.62, 0.52]) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size > 480_000) continue;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not prepare the generated image for saving."));
      reader.readAsDataURL(blob);
    });
  }
  throw new Error("The generated image is too large to save. Try a simpler prompt.");
}

async function generateGroqReply(messages, { sources = [], searched = false, onToken = () => {} } = {}) {
  const recentMessages = messages.slice(-16);
  if (recentMessages[0]?.role === "assistant") recentMessages.shift();
  const dateAnswer = answerCurrentDateQuestion(recentMessages.at(-1)?.content || "");
  if (dateAnswer) {
    onToken(dateAnswer);
    return dateAnswer;
  }
  const headers = { "Content-Type": "application/json" };
  if (!demoMode) {
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) throw new Error("Your sign-in expired. Please sign in again.");
    headers.Authorization = `Bearer ${idToken}`;
  }
  const response = await fetch(`${apiBaseUrl || window.location.origin}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: recentMessages, sources, searched })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error || `Chat request failed (HTTP ${response.status}).`);
  }
  if (typeof result.reply !== "string" || !result.reply.trim()) throw new Error("The chat service returned an empty reply.");
  onToken(result.reply);
  return result.reply.trim();
}

async function saveFirebaseMessage(role, content, sources = [], image = null) {
  await firestoreSdk.addDoc(messageRef(currentConvId), {
    role,
    content,
    ...(sources.length ? { sources } : {}),
    ...(image ? { image } : {}),
    createdAt: firestoreSdk.serverTimestamp()
  });
  await firestoreSdk.setDoc(
    firestoreSdk.doc(db, "users", currentUser.uid, "conversations", currentConvId),
    { updatedAt: firestoreSdk.serverTimestamp() },
    { merge: true }
  );
}

async function sendMessage() {
  const text = inputElement.value.trim();
  if (!text || !currentUser || sendButton.disabled) return;
  const useSearch = searchNextMessage;
  const useImageGeneration = imageGenerationNextMessage;
  setSearchMode(false);
  setImageGenerationMode(false);
  inputElement.value = "";
  inputElement.style.height = "auto";
  sendButton.disabled = true;
  let pendingRow = null;

  try {
    if (demoMode) {
      await sendLocalMessage(text, useSearch, useImageGeneration);
      return;
    }
    if (!currentConvId) {
      const newConversation = await firestoreSdk.addDoc(conversationRef(), {
        title: text.slice(0, 60),
        createdAt: firestoreSdk.serverTimestamp(),
        updatedAt: firestoreSdk.serverTimestamp()
      });
      currentConvId = newConversation.id;
      openConversation(currentConvId);
    }
    await saveFirebaseMessage("user", text);
    const pending = makePendingRow(useImageGeneration ? "Creating image..." : "Thinking...");
    pendingRow = pending.row;
    messagesElement.appendChild(pendingRow);
    scrollToBottom();
    const messageSnapshot = await firestoreSdk.getDocs(
      firestoreSdk.query(messageRef(currentConvId), firestoreSdk.orderBy("createdAt", "asc"))
    );
    const history = messageSnapshot.docs.map(document => {
      const message = document.data();
      return { role: message.role, content: message.content };
    });
    if (useImageGeneration) {
      const image = await generateImage(text);
      pendingRow.remove();
      pendingRow = null;
      await saveFirebaseMessage("assistant", `Image generated from: ${text}`, [], image);
      return;
    }
    const sources = useSearch ? await searchGoogle(text) : [];
    const reply = await generateGroqReply(history, {
      sources,
      searched: useSearch,
      onToken: value => { pending.bubble.textContent = value; }
    });
    pendingRow.remove();
    pendingRow = null;
    await saveFirebaseMessage("assistant", reply, sources);
  } catch (error) {
    console.error(error);
    if (pendingRow) pendingRow.remove();
    showError(error.message);
  } finally {
    sendButton.disabled = false;
  }
}

function makePendingRow(label = "Thinking...") {
  const row = document.createElement("article");
  row.className = "msg-row assistant pending";
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = label;
  row.appendChild(bubble);
  return { row, bubble };
}

async function sendLocalMessage(text, useSearch, useImageGeneration) {
  let conversation = localConversations.find(item => item.id === currentConvId);
  if (!conversation) {
    conversation = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      title: text.slice(0, 60),
      updatedAt: Date.now(),
      messages: []
    };
    localConversations.unshift(conversation);
    currentConvId = conversation.id;
  }
  conversation.messages.push({ role: "user", content: text });
  conversation.updatedAt = Date.now();
  storeLocalConversations();
  renderConversationList();
  renderMessages(conversation.messages);
  const pending = makePendingRow(useImageGeneration ? "Creating image..." : "Thinking...");
  messagesElement.appendChild(pending.row);
  scrollToBottom();
  try {
    if (useImageGeneration) {
      const image = await generateImage(text);
      conversation.messages.push({ role: "assistant", content: `Image generated from: ${text}`, image });
      conversation.updatedAt = Date.now();
      storeLocalConversations();
      renderConversationList();
      renderMessages(conversation.messages);
      return;
    }
    const sources = useSearch ? await searchGoogle(text) : [];
    const reply = await generateGroqReply(conversation.messages.slice(-16), {
      sources,
      searched: useSearch,
      onToken: value => { pending.bubble.textContent = value; }
    });
    conversation.messages.push({ role: "assistant", content: reply, sources });
    conversation.updatedAt = Date.now();
    storeLocalConversations();
    renderConversationList();
    renderMessages(conversation.messages);
  } finally {
    pending.row.remove();
  }
}

function bindComposer() {
  inputElement.addEventListener("input", () => {
    inputElement.style.height = "auto";
    inputElement.style.height = `${Math.min(inputElement.scrollHeight, 200)}px`;
  });
  inputElement.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && settings.enterToSend) {
      event.preventDefault();
      sendMessage();
    }
  });
  sendButton.addEventListener("click", sendMessage);
}

function startApp() {
  bindSettings();
  bindNavigation();
  bindComposer();
  if (demoMode) {
    try {
      const saved = JSON.parse(localStorage.getItem(conversationStorageKey) || "[]");
      if (Array.isArray(saved)) localConversations = saved;
    } catch {}
    currentUser = { uid: "local-preview", email: "Local preview" };
    authScreen.classList.add("hidden");
    appElement.classList.remove("hidden");
    emailElement.textContent = currentUser.email;
    renderConversationList();
  } else {
    byId("btn-signin").addEventListener("click", () => authenticate(authSdk.signInWithEmailAndPassword));
    byId("btn-signup").addEventListener("click", () => authenticate(authSdk.createUserWithEmailAndPassword));
    authSdk.onAuthStateChanged(auth, user => {
      currentUser = user;
      if (!user) {
        authScreen.classList.remove("hidden");
        appElement.classList.add("hidden");
        if (unsubConversations) unsubConversations();
        if (unsubMessages) unsubMessages();
        return;
      }
      authScreen.classList.add("hidden");
      appElement.classList.remove("hidden");
      emailElement.textContent = user.email || "Signed in";
      listenConversations();
    });
  }
}

function authenticate(method) {
  authError.textContent = "";
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    authError.textContent = "Enter an email and password.";
    return;
  }
  method(auth, email, password).catch(error => {
    authError.textContent = error.message.replace("Firebase: ", "");
  });
}

startApp();
