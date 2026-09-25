import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, doc, setDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
const chatCompletion = httpsCallable(functions, "chatCompletion");

// ---------- DOM ----------
const authScreen = document.getElementById("auth-screen");
const appEl = document.getElementById("app");
const authEmail = document.getElementById("auth-email");
const authPassword = document.getElementById("auth-password");
const authError = document.getElementById("auth-error");
const btnSignin = document.getElementById("btn-signin");
const btnSignup = document.getElementById("btn-signup");
const btnSignout = document.getElementById("btn-signout");
const userEmailEl = document.getElementById("user-email");
const convListEl = document.getElementById("conversation-list");
const messagesEl = document.getElementById("messages");
const emptyState = document.getElementById("empty-state");
const inputEl = document.getElementById("input");
const btnSend = document.getElementById("btn-send");
const btnNewChat = document.getElementById("btn-new-chat");

let currentUser = null;
let currentConvId = null;
let unsubMessages = null;
let unsubConvs = null;

// ---------- Auth ----------
btnSignin.onclick = () => doAuth(signInWithEmailAndPassword);
btnSignup.onclick = () => doAuth(createUserWithEmailAndPassword);

function doAuth(fn) {
  authError.textContent = "";
  const email = authEmail.value.trim();
  const password = authPassword.value;
  if (!email || !password) {
    authError.textContent = "Enter an email and password.";
    return;
  }
  fn(auth, email, password).catch(err => {
    authError.textContent = err.message.replace("Firebase: ", "");
  });
}

btnSignout.onclick = () => signOut(auth);

onAuthStateChanged(auth, user => {
  currentUser = user;
  if (user) {
    authScreen.classList.add("hidden");
    appEl.classList.remove("hidden");
    userEmailEl.textContent = user.email || "Signed in";
    listenConversations();
  } else {
    authScreen.classList.remove("hidden");
    appEl.classList.add("hidden");
    if (unsubConvs) unsubConvs();
    if (unsubMessages) unsubMessages();
    convListEl.innerHTML = "";
    messagesEl.innerHTML = "";
    currentConvId = null;
  }
});

// ---------- Conversations ----------
function convRef() {
  return collection(db, "users", currentUser.uid, "conversations");
}
function msgRef(convId) {
  return collection(db, "users", currentUser.uid, "conversations", convId, "messages");
}

function listenConversations() {
  const q = query(convRef(), orderBy("updatedAt", "desc"));
  unsubConvs = onSnapshot(q, snap => {
    convListEl.innerHTML = "";
    snap.forEach(docSnap => {
      const data = docSnap.data();
      const item = document.createElement("div");
      item.className = "conv-item" + (docSnap.id === currentConvId ? " active" : "");
      const title = document.createElement("span");
      title.textContent = data.title || "New chat";
      item.appendChild(title);
      const del = document.createElement("button");
      del.className = "conv-delete";
      del.textContent = "\u00d7";
      del.onclick = (e) => {
        e.stopPropagation();
        deleteDoc(doc(db, "users", currentUser.uid, "conversations", docSnap.id));
        if (docSnap.id === currentConvId) startNewChat(false);
      };
      item.appendChild(del);
      item.onclick = () => openConversation(docSnap.id);
      convListEl.appendChild(item);
    });
  });
}

btnNewChat.onclick = () => startNewChat(true);

function startNewChat(focus) {
  currentConvId = null;
  messagesEl.innerHTML = "";
  messagesEl.appendChild(emptyState);
  emptyState.classList.remove("hidden");
  highlightActiveConv();
  if (focus) inputEl.focus();
}

function openConversation(convId) {
  currentConvId = convId;
  highlightActiveConv();
  if (unsubMessages) unsubMessages();
  const q = query(msgRef(convId), orderBy("createdAt", "asc"));
  unsubMessages = onSnapshot(q, snap => {
    messagesEl.innerHTML = "";
    if (snap.empty) {
      messagesEl.appendChild(emptyState);
      return;
    }
    snap.forEach(docSnap => renderMessage(docSnap.data()));
    scrollToBottom();
  });
}

function highlightActiveConv() {
  document.querySelectorAll(".conv-item").forEach(el => el.classList.remove("active"));
}

function renderMessage(msg) {
  const row = document.createElement("div");
  row.className = "msg-row " + msg.role;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = msg.content;
  row.appendChild(bubble);
  messagesEl.appendChild(row);
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Sending messages ----------
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
});
inputEl.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
btnSend.onclick = send;

async function send() {
  const text = inputEl.value.trim();
  if (!text || !currentUser) return;
  inputEl.value = "";
  inputEl.style.height = "auto";
  btnSend.disabled = true;

  try {
    // Create conversation if needed
    if (!currentConvId) {
      const newConv = await addDoc(convRef(), {
        title: text.slice(0, 60),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      currentConvId = newConv.id;
      openConversation(currentConvId);
    }

    await addDoc(msgRef(currentConvId), {
      role: "user",
      content: text,
      createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "users", currentUser.uid, "conversations", currentConvId),
      { updatedAt: serverTimestamp() }, { merge: true });

    // Show a pending assistant bubble
    const pendingRow = document.createElement("div");
    pendingRow.className = "msg-row assistant pending";
    pendingRow.innerHTML = '<div class="msg-bubble">Thinking…</div>';
    messagesEl.appendChild(pendingRow);
    scrollToBottom();

    // Build history for the model call
    const historySnap = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js")
      .then(({ getDocs, query: q2, orderBy: ob2 }) => getDocs(q2(msgRef(currentConvId), ob2("createdAt", "asc"))));
    const history = [];
    historySnap.forEach(d => {
      const m = d.data();
      history.push({ role: m.role, content: m.content });
    });

    const result = await chatCompletion({ convId: currentConvId, messages: history });
    const replyText = result.data.reply;

    pendingRow.remove();

    await addDoc(msgRef(currentConvId), {
      role: "assistant",
      content: replyText,
      createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "users", currentUser.uid, "conversations", currentConvId),
      { updatedAt: serverTimestamp() }, { merge: true });

  } catch (err) {
    console.error(err);
    const errRow = document.createElement("div");
    errRow.className = "msg-row assistant";
    errRow.innerHTML = `<div class="msg-bubble">Error: ${err.message}</div>`;
    messagesEl.appendChild(errRow);
  } finally {
    btnSend.disabled = false;
  }
}

startNewChat(false);
