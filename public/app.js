import {
  apiRequest,
  buildMediaUrl,
  debounce,
  fileToDataUrl,
  formatDateTime,
  formatStatus,
  getSessionById,
  loadPanelState,
  savePanelState,
} from "./shared.js?v=20260317-7";

const state = {
  sessions: [],
  conversations: [],
  messages: [],
  selectedConversation: null,
  hasOlderMessages: false,
  remoteHistoryExhausted: false,
  loadingOlderMessages: false,
  messagePageSize: 120,
  refreshTimer: null,
  selectedFile: null,
  conversationSearch: "",
  selectedSessionId: "",
  selectedConversationJid: "",
};

const sessionSelect = document.getElementById("sessionSelect");
const sessionStatus = document.getElementById("sessionStatus");
const refreshConversationsButton = document.getElementById("refreshConversationsButton");
const conversationSearchInput = document.getElementById("conversationSearchInput");
const conversationList = document.getElementById("conversationList");
const conversationTitle = document.getElementById("conversationTitle");
const conversationMeta = document.getElementById("conversationMeta");
const chatNotice = document.getElementById("chatNotice");
const messageList = document.getElementById("messageList");
const composerForm = document.getElementById("composerForm");
const composerInput = document.getElementById("composerInput");
const composerFileInput = document.getElementById("composerFileInput");
const composerMediaKind = document.getElementById("composerMediaKind");
const composerFileChip = document.getElementById("composerFileChip");
const composerFileName = document.getElementById("composerFileName");
const composerClearFileButton = document.getElementById("composerClearFileButton");
const sendButton = document.getElementById("sendButton");

loadInitialState();
bindEvents();
void bootstrap();

function loadInitialState() {
  const saved = loadPanelState();
  state.selectedSessionId = saved.selectedSessionId || "";
  state.selectedConversationJid = saved.selectedConversationJid || "";
}

function bindEvents() {
  sessionSelect.addEventListener("change", async () => {
    state.selectedSessionId = sessionSelect.value || "";
    state.selectedConversationJid = "";
    resetLoadedConversationState();
    persistSelection();
    renderSessionHeader();
    await refreshConversations(true, { preserveMessagesScroll: false });
  });

  refreshConversationsButton.addEventListener("click", async () => {
    await refreshConversations(true, { preserveMessagesScroll: true });
  });

  conversationSearchInput.addEventListener(
    "input",
    debounce(async (event) => {
      state.conversationSearch = String(event.target.value || "").trim();
      await refreshConversations(true, { preserveMessagesScroll: false });
    }, 220),
  );

  messageList.addEventListener("scroll", () => {
    if (messageList.scrollTop > 40) {
      return;
    }

    void loadOlderMessages();
  });

  composerFileInput.addEventListener("change", () => {
    state.selectedFile = composerFileInput.files?.[0] || null;
    renderSelectedFile();
  });

  composerClearFileButton.addEventListener("click", () => {
    clearSelectedFile();
  });

  composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendComposerMessage();
  });
}

async function bootstrap() {
  startAutoRefresh();
  await refreshSessions(true);
}

function startAutoRefresh() {
  if (state.refreshTimer) {
    window.clearInterval(state.refreshTimer);
  }

  state.refreshTimer = window.setInterval(() => {
    void refreshSessions();
  }, 8000);
}

async function refreshSessions(force = false) {
  if (force) {
    sessionStatus.textContent = "atualizando";
  }

  const response = await apiRequest("/api/sessions");
  if (!response.ok) {
    sessionStatus.className = "status-pill status-disconnected";
    sessionStatus.textContent = "erro";
    chatNotice.textContent = response.error || "Nao foi possivel carregar as sessoes.";
    return;
  }

  state.sessions = response.data.sessions || [];

  if (state.selectedSessionId) {
    const selectedSessionStillExists = state.sessions.some((session) => session.id === state.selectedSessionId);
    if (!selectedSessionStillExists) {
      state.selectedSessionId = "";
      state.selectedConversationJid = "";
    }
  }

  if (!state.selectedSessionId && state.sessions.length) {
    state.selectedSessionId = state.sessions[0].id;
  }

  persistSelection();
  renderSessionSelect();
  renderSessionHeader();

  if (state.selectedSessionId) {
    await refreshConversations(false, { preserveMessagesScroll: true });
  } else {
    renderConversations([]);
    resetLoadedConversationState();
    renderMessages([]);
  }
}

function renderSessionSelect() {
  sessionSelect.innerHTML = "";

  if (!state.sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Nenhuma sessao";
    sessionSelect.appendChild(option);
    sessionSelect.disabled = true;
    return;
  }

  sessionSelect.disabled = false;

  state.sessions.forEach((session) => {
    const option = document.createElement("option");
    option.value = session.id;
    option.selected = session.id === state.selectedSessionId;
    option.textContent = `${session.name} • ${formatStatus(session.snapshot.status)}`;
    sessionSelect.appendChild(option);
  });
}

function renderSessionHeader() {
  const session = getSelectedSession();

  if (!session) {
    sessionStatus.className = "status-pill status-idle";
    sessionStatus.textContent = "inativa";
    chatNotice.textContent = "Crie ou conecte uma sessao em Gerenciar sessoes.";
    return;
  }

  sessionStatus.className = `status-pill status-${session.snapshot.status || "idle"}`;
  sessionStatus.textContent = formatStatus(session.snapshot.status || "idle");

  if (session.snapshot.status === "connected") {
    chatNotice.textContent = `${session.stats.conversationCount} conversas carregadas nesta sessao.`;
    return;
  }

  if (session.snapshot.status === "qr") {
    chatNotice.textContent = "O QR desta sessao esta disponivel na pagina de sessoes.";
    return;
  }

  if (session.snapshot.lastError) {
    chatNotice.textContent = session.snapshot.lastError;
    return;
  }

  chatNotice.textContent = "Use a pagina de sessoes para conectar, resetar ou excluir o dispositivo.";
}

async function refreshConversations(force = false, options = {}) {
  if (!state.selectedSessionId) {
    renderConversations([]);
    resetLoadedConversationState();
    renderMessages([]);
    return;
  }

  if (force) {
    conversationList.innerHTML = '<p class="empty">Carregando conversas...</p>';
  }

  const params = new URLSearchParams();
  params.set("limit", "500");
  if (state.conversationSearch) {
    params.set("search", state.conversationSearch);
  }

  const response = await apiRequest(
    `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/conversations?${params.toString()}`,
  );

  if (!response.ok) {
    conversationList.innerHTML = `<p class="empty">${response.error || "Falha ao carregar conversas."}</p>`;
    return;
  }

  state.conversations = response.data.conversations || [];

  if (state.selectedConversationJid) {
    const stillExists = state.conversations.some(
      (conversation) => conversation.jid === state.selectedConversationJid,
    );
    if (!stillExists) {
      state.selectedConversationJid = "";
      resetLoadedConversationState();
    }
  }

  renderConversations(state.conversations);

  if (state.selectedConversationJid && options.refreshSelectedMessages !== false) {
    await fetchMessages(state.selectedConversationJid, {
      silent: true,
      limit: Math.max(state.messages.length || 0, state.messagePageSize),
      markRead: false,
      refreshConversations: false,
      preserveScroll: Boolean(options.preserveMessagesScroll),
    });
  } else if (!state.selectedConversationJid) {
    resetLoadedConversationState();
    renderMessages([]);
  }
}

function renderConversations(conversations) {
  if (!conversations.length) {
    conversationList.innerHTML = '<p class="empty">Nenhuma conversa encontrada.</p>';
    return;
  }

  conversationList.innerHTML = "";

  conversations.forEach((conversation) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-card${conversation.jid === state.selectedConversationJid ? " active" : ""}`;
    button.addEventListener("click", async () => {
      state.selectedConversationJid = conversation.jid;
      resetLoadedConversationState();
      persistSelection();
      renderConversations(state.conversations);
      await fetchMessages(conversation.jid, { stickToBottom: true });
    });

    const top = document.createElement("div");
    top.className = "conversation-top";

    const title = document.createElement("strong");
    title.textContent = conversation.title;

    const badge = document.createElement("span");
    badge.className = "conversation-badge";
    badge.hidden = !conversation.unreadCount;
    badge.textContent = conversation.unreadCount ? String(conversation.unreadCount) : "";

    const jid = document.createElement("p");
    jid.className = "card-meta";
    jid.textContent = conversation.displayJid || conversation.jid;

    const preview = document.createElement("p");
    preview.className = "preview";
    preview.textContent = conversation.preview || "Sem mensagens.";

    top.append(title, badge);
    button.append(top, jid, preview);
    conversationList.appendChild(button);
  });
}

async function fetchMessages(jid, options = {}) {
  if (!state.selectedSessionId || !jid) {
    resetLoadedConversationState();
    renderMessages([]);
    return 0;
  }

  if (!options.silent) {
    messageList.innerHTML = '<p class="empty">Carregando historico...</p>';
  }

  const params = new URLSearchParams();
  params.set("limit", String(options.limit || state.messagePageSize));
  if (options.beforeId) {
    params.set("beforeId", options.beforeId);
  }

  const response = await apiRequest(
    `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/conversations/${encodeURIComponent(jid)}/messages?${params.toString()}`,
  );

  if (!response.ok) {
    messageList.innerHTML = `<p class="empty">${response.error || "Falha ao carregar mensagens."}</p>`;
    return 0;
  }

  const incomingMessages = response.data.messages || [];
  const conversation = response.data.conversation || null;
  const page = response.data.page || {};

  state.selectedConversationJid = jid;
  state.selectedConversation = conversation;
  state.hasOlderMessages = Boolean(page.hasOlder);

  if (options.prepend) {
    state.messages = mergeMessages(incomingMessages, state.messages);
    if (incomingMessages.length > 0) {
      state.remoteHistoryExhausted = false;
    }
  } else {
    state.messages = incomingMessages;
  }

  persistSelection();
  renderMessages(state.messages, conversation, {
    preserveTopInsert: Boolean(options.prepend),
    preserveScroll: Boolean(options.preserveScroll),
    stickToBottom: Boolean(options.stickToBottom),
  });

  if (options.markRead !== false) {
    await apiRequest(
      `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/conversations/${encodeURIComponent(jid)}/read`,
      { method: "POST" },
    );
  }

  if (options.refreshConversations !== false) {
    await refreshConversations(false, { refreshSelectedMessages: false });
  }

  return incomingMessages.length;
}

function renderMessages(messages, conversation = null, options = {}) {
  const previousScrollTop = messageList.scrollTop;
  const previousScrollHeight = messageList.scrollHeight;
  const previousDistanceFromBottom =
    messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;

  if (!conversation) {
    conversationTitle.textContent = "Selecione uma conversa";
    conversationMeta.textContent = "Escolha uma conversa na lateral para abrir o historico.";
  } else {
    conversationTitle.textContent = conversation.title;
    conversationMeta.textContent =
      `${conversation.displayJid || conversation.jid} • ${conversation.messageCount} mensagens`;
  }

  if (!messages.length) {
    messageList.innerHTML = '<p class="empty">Nenhuma mensagem para mostrar.</p>';
    return;
  }

  messageList.innerHTML = "";

  messages.forEach((message) => {
    const bubble = document.createElement("article");
    bubble.className = `message ${message.fromMe ? "out" : "in"}`;

    const mediaBlock = createMediaBlock(message);
    if (mediaBlock) {
      bubble.appendChild(mediaBlock);
    }

    const displayText = normalizeDisplayText(message);
    if (displayText) {
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = displayText;
      bubble.appendChild(text);
    }

    const meta = document.createElement("p");
    meta.className = "message-meta";
    meta.textContent = `${message.fromMe ? "enviada" : "recebida"} • ${formatDateTime(message.timestamp)}`;
    bubble.appendChild(meta);

    messageList.appendChild(bubble);
  });

  if (options.stickToBottom) {
    messageList.scrollTop = messageList.scrollHeight;
    return;
  }

  if (options.preserveTopInsert) {
    const heightDelta = messageList.scrollHeight - previousScrollHeight;
    messageList.scrollTop = previousScrollTop + heightDelta;
    return;
  }

  if (options.preserveScroll) {
    const nextScrollTop =
      messageList.scrollHeight - messageList.clientHeight - previousDistanceFromBottom;
    messageList.scrollTop = Math.max(0, nextScrollTop);
  }
}

function createMediaBlock(message) {
  if (!message.media) {
    return null;
  }

  const wrapper = document.createElement("div");
  wrapper.className = `message-media ${message.media.kind}`;
  const mediaUrl = buildMediaUrl(state.selectedSessionId, message.id);

  if (message.media.kind === "image" || message.media.kind === "sticker") {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.src = mediaUrl;
    image.alt = message.media.fileName || message.media.kind;
    wrapper.appendChild(image);
    return wrapper;
  }

  if (message.media.kind === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = mediaUrl;
    wrapper.appendChild(video);
    return wrapper;
  }

  if (message.media.kind === "audio") {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = mediaUrl;
    wrapper.appendChild(audio);
    return wrapper;
  }

  const link = document.createElement("a");
  link.className = "document-link";
  link.href = mediaUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.download = message.media.fileName || "";
  link.innerHTML = `<span>Arquivo</span><small>${message.media.fileName || message.media.mimeType || "Baixar"}</small>`;
  wrapper.appendChild(link);
  return wrapper;
}

function normalizeDisplayText(message) {
  const text = String(message.text || "").trim();
  if (!text) {
    return "";
  }

  if (!message.media) {
    return text;
  }

  const placeholders = new Set(["[imagem]", "[video]", "[audio]", "[sticker]", "[documento]"]);
  return placeholders.has(text) ? "" : text;
}

async function loadOlderMessages() {
  if (
    !state.selectedSessionId ||
    !state.selectedConversationJid ||
    !state.messages.length ||
    state.loadingOlderMessages
  ) {
    return;
  }

  if (!state.hasOlderMessages && state.remoteHistoryExhausted) {
    return;
  }

  state.loadingOlderMessages = true;
  const oldestMessageId = state.messages[0]?.id;

  try {
    let loadedCount = 0;

    if (state.hasOlderMessages && oldestMessageId) {
      loadedCount = await fetchMessages(state.selectedConversationJid, {
        silent: true,
        beforeId: oldestMessageId,
        prepend: true,
        limit: state.messagePageSize,
        markRead: false,
        refreshConversations: false,
      });
    }

    if (!loadedCount && !state.remoteHistoryExhausted) {
      const historyResponse = await apiRequest(
        `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/conversations/${encodeURIComponent(state.selectedConversationJid)}/history`,
        {
          method: "POST",
          body: JSON.stringify({ count: state.messagePageSize }),
        },
      );

      if (!historyResponse.ok) {
        throw new Error(historyResponse.error || "Nao foi possivel buscar mensagens antigas.");
      }

      if (historyResponse.data.requiresBootstrap) {
        state.remoteHistoryExhausted = true;
        chatNotice.textContent =
          "Essa conversa ainda nao trouxe historico completo. Use a pagina de sessoes para resetar e reconectar.";
        return;
      }

      if (!historyResponse.data.importedCount) {
        state.remoteHistoryExhausted = true;
        return;
      }

      loadedCount = await fetchMessages(state.selectedConversationJid, {
        silent: true,
        beforeId: oldestMessageId,
        prepend: true,
        limit: state.messagePageSize,
        markRead: false,
        refreshConversations: false,
      });

      if (!loadedCount) {
        state.remoteHistoryExhausted = true;
      }
    }
  } catch (error) {
    chatNotice.textContent = error.message;
  } finally {
    state.loadingOlderMessages = false;
  }
}

async function sendComposerMessage() {
  if (!state.selectedSessionId || !state.selectedConversationJid) {
    chatNotice.textContent = "Selecione uma sessao e uma conversa antes de enviar.";
    return;
  }

  const text = composerInput.value.trim();
  const file = state.selectedFile;

  if (!text && !file) {
    composerInput.focus();
    return;
  }

  sendButton.disabled = true;
  chatNotice.textContent = "Enviando...";

  try {
    let media = null;

    if (file) {
      media = {
        kind: composerMediaKind.value || "auto",
        mimeType: file.type || "",
        fileName: file.name || "",
        data: await fileToDataUrl(file),
      };
    }

    const response = await apiRequest(
      `/api/sessions/${encodeURIComponent(state.selectedSessionId)}/messages/send`,
      {
        method: "POST",
        body: JSON.stringify({
          jid: state.selectedConversationJid,
          text,
          media,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(response.error || "Nao foi possivel enviar.");
    }

    composerInput.value = "";
    clearSelectedFile();
    chatNotice.textContent = "Mensagem enviada.";

    await fetchMessages(state.selectedConversationJid, {
      silent: true,
      limit: Math.max(state.messages.length + 1, state.messagePageSize),
      stickToBottom: true,
      markRead: false,
    });
  } catch (error) {
    chatNotice.textContent = error.message;
  } finally {
    sendButton.disabled = false;
  }
}

function clearSelectedFile() {
  state.selectedFile = null;
  composerFileInput.value = "";
  renderSelectedFile();
}

function renderSelectedFile() {
  if (!state.selectedFile) {
    composerFileChip.hidden = true;
    composerFileName.textContent = "";
    return;
  }

  composerFileChip.hidden = false;
  composerFileName.textContent = state.selectedFile.name;
}

function mergeMessages(olderMessages, currentMessages) {
  const merged = [...olderMessages, ...currentMessages];
  const unique = new Map();

  merged.forEach((message) => {
    unique.set(message.id, message);
  });

  return [...unique.values()].sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0));
}

function resetLoadedConversationState() {
  state.messages = [];
  state.selectedConversation = null;
  state.hasOlderMessages = false;
  state.remoteHistoryExhausted = false;
  state.loadingOlderMessages = false;
}

function getSelectedSession() {
  return getSessionById(state.sessions, state.selectedSessionId);
}

function persistSelection() {
  savePanelState({
    selectedSessionId: state.selectedSessionId,
    selectedConversationJid: state.selectedConversationJid,
  });
}
