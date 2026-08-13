// ---- State --------------------------------------------------------------
let currentId = null;      // active conversation id (null = fresh, unsaved)
let sending = false;

// ---- Elements -----------------------------------------------------------
const $ = (id) => document.getElementById(id);
const messagesEl = $("messages");
const convListEl = $("convList");
const inputEl = $("input");
const formEl = $("composer");
const sendBtn = $("sendBtn");
const titleEl = $("chatTitle");
const statusEl = $("status");
const statusText = $("statusText");
const sidebar = $("sidebar");
const scrim = $("scrim");

marked.setOptions({ breaks: true, gfm: true });

const WELCOME_PROMPTS = [
  { title: "Explain a concept", body: "Explain how neural networks learn, simply", text: "Explain how neural networks learn, in simple terms." },
  { title: "Write something", body: "Draft a friendly out-of-office reply", text: "Write a friendly out-of-office email reply for a one-week vacation." },
  { title: "Brainstorm", body: "Weekend project ideas for a beginner coder", text: "Give me 5 fun weekend coding project ideas for a beginner." },
  { title: "Debug help", body: "Why might my fetch() return undefined?", text: "Why might my JavaScript fetch() call return undefined? List common causes." },
];

// ---- Rendering ----------------------------------------------------------
function renderWelcome() {
  titleEl.textContent = "New chat";
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="orb">✦</div>
      <h2>How can I help today?</h2>
      <p>Ask me anything — I can explain, write, brainstorm, and debug.</p>
      <div class="prompts">
        ${WELCOME_PROMPTS.map((p, i) => `
          <button class="prompt-chip" data-i="${i}">
            <b>${p.title}</b><span>${p.body}</span>
          </button>`).join("")}
      </div>
    </div>`;
  messagesEl.querySelectorAll(".prompt-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputEl.value = WELCOME_PROMPTS[btn.dataset.i].text;
      autoGrow();
      updateSendState();
      inputEl.focus();
    });
  });
}

function addMessage(role, content, { animate = true } = {}) {
  // Clear welcome state on first real message.
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();

  const row = document.createElement("div");
  row.className = `msg-row ${role === "user" ? "user" : "bot"}`;
  if (!animate) row.style.animation = "none";
  row.innerHTML = `
    <div class="avatar ${role === "user" ? "user" : "bot"}">${role === "user" ? "You"[0] : "✦"}</div>
    <div class="bubble"></div>`;
  const bubble = row.querySelector(".bubble");
  if (role === "user") {
    bubble.textContent = content;
  } else {
    bubble.innerHTML = marked.parse(content);
  }
  messagesEl.appendChild(row);
  scrollToBottom();
  return bubble;
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "msg-row bot";
  row.id = "typingRow";
  row.innerHTML = `
    <div class="avatar bot">✦</div>
    <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(row);
  scrollToBottom();
}
function removeTyping() { $("typingRow")?.remove(); }

function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function setStatus(state, text) {
  statusEl.className = "status" + (state ? " " + state : "");
  statusText.textContent = text;
}

// ---- Conversations list -------------------------------------------------
async function loadConversations() {
  try {
    const { conversations } = await (await fetch("/api/conversations")).json();
    if (!conversations.length) {
      convListEl.innerHTML = `<p class="empty-hint">No conversations yet.<br>Start chatting!</p>`;
      return;
    }
    convListEl.innerHTML = conversations.map((c) => `
      <div class="conv-item ${c.id === currentId ? "active" : ""}" data-id="${c.id}">
        <span class="conv-title">${escapeHtml(c.title)}</span>
        <button class="del" data-del="${c.id}" title="Delete">
          <svg viewBox="0 0 24 24" width="15" height="15"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 7h12M9 7V5h6v2m-7 0 1 12h6l1-12"/></svg>
        </button>
      </div>`).join("");

    convListEl.querySelectorAll(".conv-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        openConversation(Number(item.dataset.id));
        closeSidebar();
      });
    });
    convListEl.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteConversation(Number(btn.dataset.del));
      });
    });
  } catch {
    convListEl.innerHTML = `<p class="empty-hint">Couldn't load history.</p>`;
  }
}

async function openConversation(id) {
  currentId = id;
  setStatus("busy", "Loading…");
  try {
    const { messages } = await (await fetch(`/api/conversations/${id}`)).json();
    messagesEl.innerHTML = "";
    messages.forEach((m) => addMessage(m.role, m.content, { animate: false }));
    titleEl.textContent = document.querySelector(`.conv-item[data-id="${id}"] .conv-title`)?.textContent || "Chat";
    if (!messages.length) renderWelcome();
  } catch {
    renderWelcome();
  }
  setStatus("", "Ready");
  loadConversations();
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (id === currentId) startNewChat();
  else loadConversations();
}

function startNewChat() {
  currentId = null;
  renderWelcome();
  loadConversations();
  inputEl.focus();
  closeSidebar();
}

// ---- Sending ------------------------------------------------------------
async function send(text) {
  if (sending || !text.trim()) return;
  sending = true;
  updateSendState();
  setStatus("busy", "Thinking…");

  addMessage("user", text);
  inputEl.value = "";
  autoGrow();
  addTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: currentId, message: text }),
    });
    const data = await res.json();
    removeTyping();
    if (!res.ok) throw new Error(data.error || "Request failed");

    currentId = data.conversationId;
    addMessage("assistant", data.reply);
    setStatus("", "Ready");
    loadConversations();
  } catch (err) {
    removeTyping();
    addMessage("assistant", "⚠️ " + (err.message || "Something went wrong. Please try again."));
    setStatus("error", "Error");
  } finally {
    sending = false;
    updateSendState();
    inputEl.focus();
  }
}

// ---- Input helpers ------------------------------------------------------
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
}
function updateSendState() {
  sendBtn.disabled = sending || !inputEl.value.trim();
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Sidebar (mobile) ---------------------------------------------------
function openSidebar() { sidebar.classList.add("open"); scrim.classList.add("show"); }
function closeSidebar() { sidebar.classList.remove("open"); scrim.classList.remove("show"); }

// ---- Events -------------------------------------------------------------
formEl.addEventListener("submit", (e) => { e.preventDefault(); send(inputEl.value); });
inputEl.addEventListener("input", () => { autoGrow(); updateSendState(); });
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(inputEl.value); }
});
$("newChat").addEventListener("click", startNewChat);
$("menuToggle").addEventListener("click", openSidebar);
scrim.addEventListener("click", closeSidebar);

// ---- Init ---------------------------------------------------------------
renderWelcome();
loadConversations();
inputEl.focus();
