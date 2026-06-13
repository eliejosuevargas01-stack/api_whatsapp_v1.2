import { createReadStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import {
  loginInstagram,
  sendInstagramMessage,
  igEmitter,
  logoutInstagram,
  resolveInstagramChallenge,
  initInstagramSessions,
  getInstagramSessionsList,
  getInstagramConversations,
  getInstagramThreadMessages,
  sendInstagramThreadMessage
} from "./instagramManager.js";
import https from "node:https";

import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import dotenv from "dotenv";
import Fastify from "fastify";
import Pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  extensionForMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SESSION_ID = "principal";
const replyEmitter = new EventEmitter();

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
};

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  port: parseInteger(process.env.PORT, 3000),
  host: process.env.HOST || "0.0.0.0",
  rateLimitMax: parseInteger(process.env.RATE_LIMIT_MAX, 120),
  rateLimitWindow: parseInteger(process.env.RATE_LIMIT_WINDOW, 60_000),
  bodyLimitBytes: Math.max(parseInteger(process.env.BODY_LIMIT_MB, 64), 1) * 1024 * 1024,
  autoConnect: parseBoolean(process.env.AUTO_CONNECT, true),
  syncFullHistory: parseBoolean(process.env.SYNC_FULL_HISTORY, true),
  maxStoredMessages:
    parseInteger(process.env.MAX_STORED_MESSAGES, 0) > 0
      ? parseInteger(process.env.MAX_STORED_MESSAGES, 0)
      : Number.POSITIVE_INFINITY,
  sessionsDir: path.resolve(process.env.SESSIONS_DIR || path.join(__dirname, "sessions")),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, "data")),
  mediaDir: path.resolve(process.env.MEDIA_DIR || path.join(__dirname, "data", "media")),
};

function getDefaultSettingsStore() {
  const webhookUrl = String(process.env.WEBHOOK_URL || "").trim();

  return normalizeSettingsStore({
    webhook: getDefaultWebhookSettings(webhookUrl),
  });
}

const paths = {
  messages: path.join(config.dataDir, "messages.json"),
  conversations: path.join(config.dataDir, "conversations.json"),
  sessions: path.join(config.dataDir, "sessions.json"),
  settings: path.join(config.dataDir, "settings.json"),
  contacts: path.join(config.dataDir, "contacts.json"),
};

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
  },
  bodyLimit: config.bodyLimitBytes,
});

await ensureDirectories([config.dataDir, config.sessionsDir, config.mediaDir]);
const migratedLegacySessionId = await migrateLegacyAuthFiles(config.sessionsDir, DEFAULT_SESSION_ID);

const stores = {
  messages: normalizeMessagesStore(
    await readJson(paths.messages, { messages: [] }),
    migratedLegacySessionId || DEFAULT_SESSION_ID,
  ),
  conversations: normalizeConversationsStore(
    await readJson(paths.conversations, { sessions: {} }),
    migratedLegacySessionId || DEFAULT_SESSION_ID,
  ),
  sessions: normalizeSessionStore(await readJson(paths.sessions, { sessions: {} })),
  settings: normalizeSettingsStore(await readJson(paths.settings, getDefaultSettingsStore())),
  contacts: normalizeContactsStore(await readJson(paths.contacts, { sessions: {} })),
};

const knownSessionIds = new Set([
  ...Object.keys(stores.sessions.sessions),
  ...listSessionIdsFromMessages(stores.messages),
  ...listSessionIdsFromConversationStore(stores.conversations),
  ...listSessionIdsFromContactStore(stores.contacts),
  ...(await listSessionDirectories(config.sessionsDir)),
]);

if (migratedLegacySessionId) {
  knownSessionIds.add(migratedLegacySessionId);
}

for (const sessionId of knownSessionIds) {
  const session = ensureSessionMeta(stores.sessions, sessionId, {
    name: sessionId === DEFAULT_SESSION_ID ? "Sessao principal" : formatSessionName(sessionId),
  });
  if (!session.webhook) {
    session.webhook = cloneWebhookSettings(stores.settings.webhook);
  }
  ensureConversationBucket(stores.conversations, sessionId);
  ensureContactBucket(stores.contacts, sessionId);
}

rebuildConversationsFromMessages(stores);

const writeMessages = createJsonWriter(paths.messages, app.log);
const writeConversations = createJsonWriter(paths.conversations, app.log);
const writeSessions = createJsonWriter(paths.sessions, app.log);
const writeSettings = createJsonWriter(paths.settings, app.log);
const writeContacts = createJsonWriter(paths.contacts, app.log);

const persistMessages = () => writeMessages(stores.messages);
const persistConversations = () => writeConversations(stores.conversations);
const persistSessions = () => writeSessions(stores.sessions);
const persistSettings = () => writeSettings(stores.settings);
const persistContacts = () => writeContacts(stores.contacts);

await Promise.all([
  persistMessages(),
  persistConversations(),
  persistSessions(),
  persistSettings(),
  persistContacts(),
]);

const messageIndex = new Set(
  stores.messages.messages.map((message) => getMessageSignature(message)),
);

const sessionManager = createSessionManager({
  app,
  config,
  stores,
  messageIndex,
  persistMessages,
  persistConversations,
  persistSessions,
  persistSettings,
  persistContacts,
});

app.register(rateLimit, {
  max: config.rateLimitMax,
  timeWindow: config.rateLimitWindow,
});

app.register(fastifyStatic, {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

app.get("/", async (request, reply) =>
  reply.header("Cache-Control", "no-store").sendFile("index.html"),
);

app.get("/sessoes", async (request, reply) =>
  reply.header("Cache-Control", "no-store").sendFile("sessions.html"),
);

app.get("/instagram.html", async (request, reply) =>
  reply.header("Cache-Control", "no-store").sendFile("instagram.html"),
);

app.get("/api/health", async () => ({
  ok: true,
  uptimeSeconds: Math.floor(process.uptime()),
  timestamp: new Date().toISOString(),
  sessionCount: Object.keys(stores.sessions.sessions).length,
}));

app.get("/api/bootstrap", async () => ({
  appName: "API WhatsApp",
}));

app.get("/api/status", async () => ({
  sessionCount: Object.keys(stores.sessions.sessions).length,
  totals: getGlobalStats(stores),
  sessions: sessionManager.listSessions(),
}));

app.get("/api/settings", async () => ({
  settings: stores.settings,
}));

app.put("/api/settings", async (request, reply) => {
  try {
    stores.settings = mergeSettingsStore(stores.settings, request.body);
    await persistSettings();

    for (const session of Object.values(stores.sessions.sessions)) {
      session.webhook = mergeSettingsStore(
        { webhook: session.webhook || cloneWebhookSettings(stores.settings.webhook) },
        request.body
      ).webhook;
    }
    await persistSessions();

    return {
      ok: true,
      settings: stores.settings,
    };
  } catch (error) {
    return reply.code(400).send({
      error: "bad_request",
      message: errorToMessage(error) || "Nao foi possivel salvar as configuracoes.",
    });
  }
});

app.get("/api/sessions/:sessionId/settings", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  if (isInstagram) {
    ensureSessionMeta(stores.sessions, sessionId);
    return {
      settings: {
        webhook: getSessionWebhookSettings(stores.sessions, sessionId),
      },
    };
  }

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  return {
    settings: {
      webhook: getSessionWebhookSettings(stores.sessions, sessionId),
    },
  };
});

app.put("/api/sessions/:sessionId/settings", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  if (isInstagram) {
    try {
      const session = ensureSessionMeta(stores.sessions, sessionId);
      session.webhook = mergeSettingsStore(
        {
          webhook: session.webhook || cloneWebhookSettings(stores.settings.webhook),
        },
        request.body,
      ).webhook;

      await persistSessions();

      return {
        ok: true,
        settings: {
          webhook: getSessionWebhookSettings(stores.sessions, sessionId),
        },
      };
    } catch (error) {
      return reply.code(400).send({
        error: "bad_request",
        message: errorToMessage(error) || "Nao foi possivel salvar as configuracoes da sessao.",
      });
    }
  }

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  try {
    const session = ensureSessionMeta(stores.sessions, sessionId);
    session.webhook = mergeSettingsStore(
      {
        webhook: session.webhook || cloneWebhookSettings(stores.settings.webhook),
      },
      request.body,
    ).webhook;

    await persistSessions();

    return {
      ok: true,
      settings: {
        webhook: getSessionWebhookSettings(stores.sessions, sessionId),
      },
    };
  } catch (error) {
    return reply.code(400).send({
      error: "bad_request",
      message: errorToMessage(error) || "Nao foi possivel salvar as configuracoes da sessao.",
    });
  }
});

app.get("/api/sessions", async () => {
  const whatsappSessions = sessionManager.listSessions();
  let instagramSessions = [];
  try {
    instagramSessions = await getInstagramSessionsList();
  } catch (error) {
    app.log.error(error, "Falha ao obter lista de sessoes do Instagram.");
  }
  return {
    sessions: [
      ...whatsappSessions.map((s) => ({ ...s, platform: "whatsapp" })),
      ...instagramSessions.map((s) => ({
        id: s.id,
        name: s.name,
        platform: "instagram",
        snapshot: { status: s.active ? "connected" : "disconnected" },
        stats: {
          conversationCount: 0,
          messageCount: 0,
          unreadCount: 0,
        },
      })),
    ],
  };
});

app.post("/api/sessions", async (request, reply) => {
  const name = String(request.body?.name || "").trim();

  if (!name) {
    return reply.code(400).send({
      error: "bad_request",
      message: "Informe um nome para a sessao.",
    });
  }

  const session = await sessionManager.createSession(name);
  return {
    ok: true,
    session,
  };
});

app.get("/api/sessions/:sessionId", async (request, reply) => {
  const session = sessionManager.getSessionSummary(request.params.sessionId);

  if (!session) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  return {
    session,
  };
});

app.post("/api/sessions/:sessionId/connect", async (request, reply) => {
  if (!sessionManager.hasSession(request.params.sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const snapshot = await sessionManager.connect(request.params.sessionId);
  return {
    ok: true,
    snapshot,
    session: sessionManager.getSessionSummary(request.params.sessionId),
  };
});

app.post("/api/sessions/:sessionId/disconnect", async (request, reply) => {
  if (!sessionManager.hasSession(request.params.sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const snapshot = await sessionManager.disconnect(request.params.sessionId);
  return {
    ok: true,
    snapshot,
    session: sessionManager.getSessionSummary(request.params.sessionId),
  };
});

app.delete("/api/sessions/:sessionId", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  if (isInstagram) {
    try {
      await logoutInstagram(sessionId);
      return {
        ok: true,
        removedSessionId: sessionId,
      };
    } catch (error) {
      return reply.code(400).send({
        error: "bad_request",
        message: error.message || "Nao foi possivel excluir a sessao do Instagram.",
      });
    }
  }

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const removedSessionId = await sessionManager.removeSession(sessionId);
  return {
    ok: true,
    removedSessionId,
  };
});

app.post("/api/sessions/:sessionId/logout", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  if (isInstagram) {
    try {
      await logoutInstagram(sessionId);
      return {
        ok: true,
        snapshot: { status: "disconnected" },
      };
    } catch (error) {
      return reply.code(400).send({
        error: "bad_request",
        message: error.message || "Nao foi possivel desconectar a sessao do Instagram.",
      });
    }
  }

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const snapshot = await sessionManager.logout(sessionId);
  return {
    ok: true,
    snapshot,
    session: sessionManager.getSessionSummary(sessionId),
  };
});

app.get("/api/sessions/:sessionId/conversations", async (request, reply) => {
  const { sessionId } = request.params;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const limit = Math.min(parseInteger(request.query?.limit, 100), 500);
  const search = String(request.query?.search || "").trim().toLowerCase();

  return {
    conversations: listSessionConversations(sessionId, stores, { limit, search, kind: "private" }),
  };
});

app.get("/api/sessions/:sessionId/status", async (request, reply) => {
  const { sessionId } = request.params;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const limit = Math.min(parseInteger(request.query?.limit, 100), 500);
  const search = String(request.query?.search || "").trim().toLowerCase();

  return {
    conversations: listSessionConversations(sessionId, stores, { limit, search, kind: "status" }),
  };
});

app.get("/api/sessions/:sessionId/conversations/:jid/messages", async (request, reply) => {
  const { sessionId, jid } = request.params;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const conversation = getConversationMeta(stores, sessionId, jid);
  if (!conversation) {
    return reply.code(404).send({
      error: "not_found",
      message: "Conversa nao encontrada.",
    });
  }

  const limit = Math.min(parseInteger(request.query?.limit, 120), config.maxStoredMessages);
  const beforeId = String(request.query?.beforeId || "").trim();
  const page = getConversationMessagesPage(sessionId, jid, stores, {
    limit,
    beforeId,
  });

  return {
    conversation: buildConversationSummary(sessionId, conversation, stores),
    messages: page.messages.map((message) => serializeMessageForClient(sessionId, message, stores)),
    page: {
      limit,
      hasOlder: page.hasOlder,
      oldestMessageId: page.oldestMessageId,
      newestMessageId: page.newestMessageId,
    },
  };
});

app.post("/api/sessions/:sessionId/conversations/:jid/history", async (request, reply) => {
  const { sessionId, jid } = request.params;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const conversation = getConversationMeta(stores, sessionId, jid);
  if (!conversation) {
    return reply.code(404).send({
      error: "not_found",
      message: "Conversa nao encontrada.",
    });
  }

  try {
    const count = Math.min(parseInteger(request.body?.count, 80), 200);
    const result = await sessionManager.loadOlderMessages(sessionId, jid, count);

    return {
      ok: true,
      importedCount: result.importedCount,
      requestId: result.requestId,
      requiresBootstrap: Boolean(result.requiresBootstrap),
      conversation: buildConversationSummary(sessionId, getConversationMeta(stores, sessionId, jid), stores),
    };
  } catch (error) {
    return reply.code(400).send({
      error: "bad_request",
      message: errorToMessage(error) || "Nao foi possivel carregar mensagens antigas.",
    });
  }
});

app.post("/api/sessions/:sessionId/conversations/:jid/read", async (request, reply) => {
  const { sessionId, jid } = request.params;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const conversation = getConversationMeta(stores, sessionId, jid);
  if (!conversation) {
    return reply.code(404).send({
      error: "not_found",
      message: "Conversa nao encontrada.",
    });
  }

  conversation.unreadCount = 0;
  await persistConversations();

  return {
    ok: true,
    conversation: buildConversationSummary(sessionId, conversation, stores),
  };
});

const dispatchInstagramWebhookMessage = async (sessionId, threadId, threadTitle, message, webhook) => {
  const payload = {
    event: "message.created",
    emittedAt: new Date().toISOString(),
    platform: "instagram",
    session: {
      id: sessionId,
      name: sessionId,
    },
    conversation: {
      jid: threadId,
      displayJid: threadId,
      title: threadTitle || "Conversa Instagram",
      kind: "private",
      updatedAt: Date.now(),
      unreadCount: 0,
      preview: message.text || "",
      lastMessageAt: Date.now(),
      messageCount: 0,
    },
    message: {
      id: `ig_${sessionId}_${threadId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      jid: threadId,
      resolvedJid: threadId,
      displayJid: threadId,
      fromMe: Boolean(message.fromMe),
      text: message.text || "",
      timestamp: Math.floor(message.timestamp || Date.now() / 1000),
      type: "text",
      status: "received",
      pushName: threadTitle || "Conversa Instagram",
      participant: null,
      participantDisplayJid: null,
      media: null,
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10000);

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Instagram-Event": payload.event,
        "X-Instagram-Session": sessionId,
        "X-WhatsApp-Event": payload.event, // compatibilidade
        "X-WhatsApp-Session": sessionId,   // compatibilidade
        ...(webhook.secret ? { "X-Webhook-Secret": webhook.secret } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      app.log.warn(
        {
          sessionId,
          statusCode: response.status,
          webhookUrl: webhook.url,
        },
        "Instagram Webhook respondeu com status nao esperado.",
      );
    }
  } catch (error) {
    app.log.warn({ error, sessionId, webhookUrl: webhook.url }, "Falha ao entregar Instagram webhook.");
  } finally {
    clearTimeout(timeout);
  }
};

// Listener para mensagens do Instagram
igEmitter.on('message', (data) => {
  const { sessionId, threadId, threadTitle, message } = data;
  app.log.info({ sessionId, threadId, message }, 'Nova mensagem recebida do Instagram');

  const webhook = getSessionWebhookSettings(stores.sessions, sessionId);
  if (!webhook.enabled || !webhook.url) {
    return;
  }

  if (message.fromMe && !webhook.includeFromMe) {
    return;
  }

  void dispatchInstagramWebhookMessage(sessionId, threadId, threadTitle, message, webhook);
});

function getNewMessages(cachedList, scrapedList) {
  if (!cachedList || cachedList.length === 0) {
    return scrapedList;
  }
  for (let i = scrapedList.length; i >= 0; i--) {
    if (i <= cachedList.length) {
      let match = true;
      for (let j = 0; j < i; j++) {
        const cachedItem = cachedList[cachedList.length - i + j];
        const scrapedItem = scrapedList[j];
        if (cachedItem.text !== scrapedItem.text || cachedItem.fromMe !== scrapedItem.fromMe) {
          match = false;
          break;
        }
      }
      if (match) {
        return scrapedList.slice(i);
      }
    }
  }
  return scrapedList;
}

const activeScrapes = new Set();
const instagramMessageCache = new Map();

async function runScrapeForSession(username) {
  app.log.debug(`[Instagram-Scraper] Iniciando raspagem de inbox para @${username}`);
  try {
    const conversations = await getInstagramConversations(username);

    for (const convo of conversations) {
      const threadId = convo.jid;
      const cacheKey = `${username}:${threadId}`;
      const hasUnread = convo.unreadCount > 0;

      let cached = instagramMessageCache.get(cacheKey);
      let shouldFetch = false;

      if (!cached) {
        shouldFetch = true;
      } else if (hasUnread) {
        shouldFetch = true;
      } else {
        const lastCachedMsg = cached[cached.length - 1];
        if (lastCachedMsg && convo.preview && lastCachedMsg.text !== convo.preview) {
          shouldFetch = true;
        }
      }

      if (shouldFetch) {
        app.log.debug(`[Instagram-Scraper] Buscando mensagens do thread ${threadId} para @${username}`);
        const scrapedMessages = await getInstagramThreadMessages(username, threadId);

        if (!cached) {
          instagramMessageCache.set(cacheKey, scrapedMessages);
          app.log.debug(`[Instagram-Scraper] Cache semeado com ${scrapedMessages.length} mensagens para @${username} (thread: ${threadId})`);
          continue;
        }

        const newMessages = getNewMessages(cached, scrapedMessages);
        instagramMessageCache.set(cacheKey, scrapedMessages);

        for (const msg of newMessages) {
          app.log.info(`[Instagram-Scraper] Nova mensagem detectada em @${username} (thread: ${threadId}): ${msg.text}`);
          igEmitter.emit('message', {
            sessionId: username,
            threadId: threadId,
            threadTitle: convo.title,
            message: msg
          });
        }
      }
    }
  } catch (error) {
    app.log.warn({ error, username }, `Erro ao raspar inbox do Instagram para @${username}`);
  }
}

async function pollInstagramSessions() {
  let sessions = [];
  try {
    sessions = await getInstagramSessionsList();
  } catch (error) {
    app.log.error(error, "Erro ao obter lista de sessoes para polling do Instagram.");
    return;
  }

  const activeSessions = sessions.filter((s) => s.active);

  for (const session of activeSessions) {
    const username = session.id;
    if (activeScrapes.has(username)) {
      continue;
    }

    activeScrapes.add(username);
    runScrapeForSession(username).finally(() => {
      activeScrapes.delete(username);
    });
  }
}

app.post("/api/instagram/login", async (request, reply) => {
  const username = request.body?.username;
  const password = request.body?.password;

  if (!username || !password) {
    return reply.code(400).send({ error: "bad_request", message: "Informe username e password." });
  }

  try {
    const session = await loginInstagram(username, password);
    return { ok: true, session };
  } catch (error) {
    return reply.code(400).send({ error: "login_failed", message: error.message, isCheckpoint: error.isCheckpoint });
  }
});

app.post("/api/instagram/challenge", async (request, reply) => {
  const username = request.body?.username;
  const code = request.body?.code;

  if (!username || !code) {
    return reply.code(400).send({ error: "bad_request", message: "Informe username e o codigo." });
  }

  try {
    const result = await resolveInstagramChallenge(username, code);
    return { ok: true, message: result.message };
  } catch (error) {
    return reply.code(400).send({ error: "challenge_failed", message: error.message });
  }
});

app.post("/api/instagram/send", async (request, reply) => {
  const sessionId = request.body?.sessionId; // que no caso é o username do bot logado
  const usernameTo = request.body?.usernameTo;
  const text = request.body?.text;

  if (!sessionId || !usernameTo || !text) {
    return reply.code(400).send({ error: "bad_request", message: "Informe sessionId, usernameTo e text." });
  }

  try {
    const result = await sendInstagramMessage(sessionId, usernameTo, text);
    return { ok: true, result };
  } catch (error) {
    return reply.code(400).send({ error: error.errorCode || "send_failed", message: error.message, isCheckpoint: error.isCheckpoint });
  }
});

app.get("/api/instagram/sessions", async (request, reply) => {
  try {
    const sessions = await getInstagramSessionsList();
    return { sessions };
  } catch (error) {
    return reply.code(500).send({ error: "server_error", message: error.message });
  }
});

app.post("/api/instagram/sessions/:username/logout", async (request, reply) => {
  const { username } = request.params;
  try {
    await logoutInstagram(username);
    return { ok: true };
  } catch (error) {
    return reply.code(400).send({ error: "logout_failed", message: error.message });
  }
});

app.get("/api/instagram/sessions/:username/conversations", async (request, reply) => {
  const { username } = request.params;
  try {
    const conversations = await getInstagramConversations(username);
    return { conversations };
  } catch (error) {
    return reply.code(400).send({ error: "bad_request", message: error.message, isCheckpoint: error.isCheckpoint });
  }
});

app.get("/api/instagram/sessions/:username/conversations/:threadId/messages", async (request, reply) => {
  const { username, threadId } = request.params;
  try {
    const messages = await getInstagramThreadMessages(username, threadId);
    return {
      conversation: { title: "Conversa Instagram", jid: threadId },
      messages
    };
  } catch (error) {
    return reply.code(400).send({ error: "bad_request", message: error.message, isCheckpoint: error.isCheckpoint });
  }
});

app.post("/api/instagram/sessions/:username/conversations/:threadId/messages/send", async (request, reply) => {
  const { username, threadId } = request.params;
  const text = String(request.body?.text || "").trim();
  
  if (!text) {
    return reply.code(400).send({ error: "bad_request", message: "Informe o texto da mensagem." });
  }
  
  try {
    const result = await sendInstagramThreadMessage(username, threadId, text);
    return { ok: true, result };
  } catch (error) {
    return reply.code(400).send({ error: "send_failed", message: error.message, isCheckpoint: error.isCheckpoint });
  }
});

app.post("/api/sessions/:sessionId/messages/send", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  if (isInstagram) {
    let target = String(request.body?.jid || request.body?.link || "").trim();
    const text = String(request.body?.text || "").trim();
    if (!target || !text) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Informe o destinatario (jid) e a mensagem (text).",
      });
    }

    if (target.startsWith("@")) {
      target = target.substring(1);
    }

    try {
      let result;
      const isThreadId = /^\d+$/.test(target);
      if (isThreadId) {
        result = await sendInstagramThreadMessage(sessionId, target, text);
      } else {
        result = await sendInstagramMessage(sessionId, target, text);
      }
      return {
        ok: true,
        message: {
          id: `ig_sent_${Date.now()}`,
          jid: target,
          fromMe: true,
          text,
          timestamp: Math.floor(Date.now() / 1000),
          type: "text",
        },
        result
      };
    } catch (error) {
      return reply.code(400).send({
        error: "send_failed",
        message: error.message,
        isCheckpoint: error.isCheckpoint,
      });
    }
  }

  let jid = String(request.body?.jid || "").trim();
  const link = String(request.body?.link || "").trim();
  const text = String(request.body?.text || "").trim();
  const mediaInput = request.body?.media || null;
  const waitForReply = parseBoolean(request.body?.waitForReply);
  const replyTimeoutMs = Number(request.body?.replyTimeout) || 60000;

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  if ((!jid && !link) || (!text && !mediaInput)) {
    return reply.code(400).send({
      error: "bad_request",
      message: "Informe jid e uma mensagem ou arquivo.",
    });
  }

  let message;

  try {
    // Resolve link if provided as jid or link
    const target = jid || link;
    if (target.startsWith("http") || target.includes("wa.me") || target.includes("api.whatsapp.com") || target.includes("web.whatsapp.com")) {
      const extracted = await extractJidFromLink(target);
      if (extracted) {
        jid = extracted;
      } else {
        return reply.code(400).send({ error: "bad_request", message: "Nao foi possivel extrair o numero do link fornecido." });
      }
    }

    if (!jid) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Nao foi possivel determinar o destinatario.",
      });
    }

    if (mediaInput) {
      const media = normalizeOutboundMediaInput(mediaInput);
      message = await sessionManager.sendMedia(sessionId, jid, {
        text,
        media,
      });
    } else {
      message = await sessionManager.sendText(sessionId, jid, text);
    }
  } catch (error) {
    return reply.code(400).send({
      error: "bad_request",
      message: errorToMessage(error) || "Nao foi possivel enviar a mensagem.",
    });
  }

  if (waitForReply) {
    try {
      const replyMessage = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          replyEmitter.off(`reply_${sessionId}_${message.jid}`, onReply);
          resolve(null);
        }, replyTimeoutMs);

        const onReply = (incomingMessage) => {
          clearTimeout(timeout);
          replyEmitter.off(`reply_${sessionId}_${message.jid}`, onReply);
          resolve(incomingMessage);
        };

        replyEmitter.on(`reply_${sessionId}_${message.jid}`, onReply);
      });

      return {
        ok: true,
        message: serializeMessageForClient(sessionId, message, stores),
        reply: replyMessage ? serializeMessageForClient(sessionId, replyMessage, stores) : null,
        replyTimeout: !replyMessage,
      };
    } catch (err) {
      // Ignore emitter errors and just return the sent message
    }
  }

  return {
    ok: true,
    message: serializeMessageForClient(sessionId, message, stores),
  };
});

app.post("/api/sessions/:sessionId/sync-today", async (request, reply) => {
  const { sessionId } = request.params;
  const isInstagram = (await getInstagramSessionsList()).some(s => s.id === sessionId);

  // Calculate start of today (local time)
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayTimestamp = Math.floor(startOfToday.getTime() / 1000);

  if (isInstagram) {
    const sessions = await getInstagramSessionsList();
    const instSession = sessions.find(s => s.id === sessionId);
    if (!instSession || !instSession.active) {
      return reply.code(400).send({
        error: "session_inactive",
        message: "A sessao do Instagram nao esta conectada/ativa.",
      });
    }

    try {
      const conversations = await getInstagramConversations(sessionId);
      const recovered = [];

      for (const convo of conversations) {
        const threadId = convo.jid;
        app.log.info(`[Sync-Today] Recuperando mensagens de ${threadId} para ${sessionId}`);
        const scrapedMessages = await getInstagramThreadMessages(sessionId, threadId);

        // Filter messages received today
        const todayMsgs = scrapedMessages.filter(m => m.timestamp >= startOfTodayTimestamp);
        
        // Find last outgoing message today
        let lastOutgoingIdx = -1;
        for (let i = todayMsgs.length - 1; i >= 0; i--) {
          if (todayMsgs[i].fromMe) {
            lastOutgoingIdx = i;
            break;
          }
        }

        // Get incoming messages after the last outgoing message today
        const targetMessages = todayMsgs.slice(lastOutgoingIdx + 1).filter(m => !m.fromMe);

        for (const msg of targetMessages) {
          app.log.info(`[Sync-Today] Despachando webhook para mensagem recuperada do Instagram: ${msg.text}`);
          igEmitter.emit('message', {
            sessionId: sessionId,
            threadId: threadId,
            threadTitle: convo.title,
            message: msg
          });
          recovered.push({
            threadId,
            title: convo.title,
            text: msg.text,
            timestamp: msg.timestamp
          });
        }
      }

      return {
        ok: true,
        platform: "instagram",
        checkedConversations: conversations.length,
        dispatchedWebhooksCount: recovered.length,
        recoveredMessages: recovered
      };
    } catch (error) {
      return reply.code(500).send({
        error: "sync_failed",
        message: error.message,
        isCheckpoint: error.isCheckpoint
      });
    }
  }

  // WhatsApp
  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  const summary = sessionManager.getSessionSummary(sessionId);
  if (!summary || summary.snapshot?.status !== "connected") {
    return reply.code(400).send({
      error: "session_not_connected",
      message: "A sessao do WhatsApp nao esta conectada.",
    });
  }

  try {
    const todayMsgs = stores.messages.messages.filter(m => 
      m.sessionId === sessionId && 
      m.timestamp >= startOfTodayTimestamp
    );

    const messagesByJid = {};
    for (const msg of todayMsgs) {
      if (!messagesByJid[msg.jid]) {
        messagesByJid[msg.jid] = [];
      }
      messagesByJid[msg.jid].push(msg);
    }

    const recovered = [];

    for (const [jid, msgs] of Object.entries(messagesByJid)) {
      msgs.sort((a, b) => a.timestamp - b.timestamp);

      let lastOutgoingIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].fromMe) {
          lastOutgoingIdx = i;
          break;
        }
      }

      const targetMessages = msgs.slice(lastOutgoingIdx + 1).filter(m => !m.fromMe);

      for (const msg of targetMessages) {
        app.log.info(`[Sync-Today] Despachando webhook para mensagem recuperada do WhatsApp: ${msg.text}`);
        void sessionManager.dispatchWebhookMessage(sessionId, msg);
        recovered.push({
          jid: jid,
          text: msg.text,
          timestamp: msg.timestamp
        });
      }
    }

    return {
      ok: true,
      platform: "whatsapp",
      checkedConversations: Object.keys(messagesByJid).length,
      dispatchedWebhooksCount: recovered.length,
      recoveredMessages: recovered
    };
  } catch (error) {
    return reply.code(500).send({
      error: "sync_failed",
      message: error.message
    });
  }
});

app.get("/api/sessions/:sessionId/check-number", async (request, reply) => {
  const { sessionId } = request.params;
  let phone = String(request.query?.phone || request.query?.number || request.query?.jid || "").trim();

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  if (!phone) {
    return reply.code(400).send({
      error: "bad_request",
      message: "Informe o numero ou link no parametro phone, number ou jid.",
    });
  }

  const summary = sessionManager.getSessionSummary(sessionId);
  if (!summary || summary.snapshot?.status !== "connected") {
    return reply.code(400).send({
      error: "session_not_connected",
      message: "A sessao do WhatsApp nao esta conectada.",
    });
  }

  try {
    // Resolve link if it is a link
    if (phone.startsWith("http") || phone.includes("wa.me") || phone.includes("api.whatsapp.com") || phone.includes("web.whatsapp.com")) {
      const extracted = await extractJidFromLink(phone);
      if (extracted) {
        phone = extracted;
      } else {
        return reply.code(400).send({ error: "bad_request", message: "Nao foi possivel extrair o numero do link fornecido." });
      }
    }

    const rawJid = normalizeJidInput(phone);
    const resolvedJid = await sessionManager.verifyNumberExists(sessionId, rawJid);
    return {
      exists: true,
      jid: resolvedJid,
      number: resolvedJid.split("@")[0]
    };
  } catch (error) {
    return {
      exists: false,
      message: error.message || "O numero nao esta registrado no WhatsApp."
    };
  }
});

app.get("/api/sessions/:sessionId/resolve-lid", async (request, reply) => {
  const { sessionId } = request.params;
  let phone = String(request.query?.phone || request.query?.number || request.query?.jid || "").trim();

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  if (!phone) {
    return reply.code(400).send({
      error: "bad_request",
      message: "Informe o numero ou link no parametro phone, number ou jid.",
    });
  }

  const summary = sessionManager.getSessionSummary(sessionId);
  if (!summary || summary.snapshot?.status !== "connected") {
    return reply.code(400).send({
      error: "session_not_connected",
      message: "A sessao do WhatsApp nao esta conectada.",
    });
  }

  try {
    if (phone.startsWith("http") || phone.includes("wa.me") || phone.includes("api.whatsapp.com") || phone.includes("web.whatsapp.com")) {
      const extracted = await extractJidFromLink(phone);
      if (extracted) {
        phone = extracted;
      } else {
        return reply.code(400).send({ error: "bad_request", message: "Nao foi possivel extrair o numero do link fornecido." });
      }
    }

    const result = await sessionManager.resolveLid(sessionId, phone);
    if (result.exists) {
      return {
        exists: true,
        jid: result.jid,
        lid: result.lid
      };
    } else {
      return reply.code(404).send({
        exists: false,
        message: result.message || "O numero informado nao esta registrado no WhatsApp."
      });
    }
  } catch (error) {
    return reply.code(500).send({
      error: "internal_error",
      message: error.message || "Erro ao resolver o LID."
    });
  }
});

app.get("/api/sessions/:sessionId/media", async (request, reply) => {
  const { sessionId } = request.params;
  const messageId = String(request.query?.messageId || "").trim();

  if (!sessionManager.hasSession(sessionId)) {
    return reply.code(404).send({
      error: "not_found",
      message: "Sessao nao encontrada.",
    });
  }

  if (!messageId) {
    return reply.code(400).send({
      error: "bad_request",
      message: "Informe messageId.",
    });
  }

  const message = findStoredMessage(sessionId, messageId, stores);
  if (!message) {
    return reply.code(404).send({
      error: "not_found",
      message: "Mensagem nao encontrada.",
    });
  }

  if (!message.media) {
    return reply.code(404).send({
      error: "not_found",
      message: "A mensagem nao possui midia.",
    });
  }

  try {
    const resolved = await sessionManager.resolveMessageMedia(sessionId, message);
    return sendMediaFileResponse(reply, resolved.filePath, resolved.mimeType);
  } catch (error) {
    return reply.code(400).send({
      error: "bad_request",
      message: errorToMessage(error) || "Nao foi possivel carregar a midia.",
    });
  }
});

app.setNotFoundHandler(async (request, reply) => {
  if (getPathname(request.raw.url).startsWith("/api/")) {
    return reply.code(404).send({
      error: "not_found",
    });
  }

  if (request.raw.method !== "GET") {
    return reply.code(404).send({
      error: "not_found",
    });
  }

  return reply.header("Cache-Control", "no-store").sendFile("index.html");
});

try {
  await app.listen({
    host: config.host,
    port: config.port,
  });

  app.log.info(`Servidor disponivel em http://${config.host}:${config.port}`);

  if (config.autoConnect) {
    void sessionManager.autoConnectExistingSessions();
    try {
      await initInstagramSessions(config.sessionsDir);
    } catch (igError) {
      app.log.error({ error: igError }, "Falha ao restaurar sessoes do Instagram.");
    }
  }

  // Start Instagram background polling loop
  setTimeout(() => {
    void pollInstagramSessions();
  }, 5000);
  setInterval(() => {
    void pollInstagramSessions();
  }, 30000);
} catch (error) {
  app.log.error({ error }, "Falha ao iniciar o servidor.");
  process.exit(1);
}

const shutdown = async (signal) => {
  app.log.info({ signal }, "Encerrando aplicacao.");
  await sessionManager.disconnectAll();
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

function createSessionManager({
  app,
  config,
  stores,
  messageIndex,
  persistMessages,
  persistConversations,
  persistSessions,
  persistContacts,
}) {
  const services = new Map();
  const logger = Pino({ level: "silent" });

  const absorbContacts = (sessionId, contacts = []) => {
    let changed = false;

    for (const contact of contacts) {
      if (upsertContact(stores.contacts, sessionId, contact)) {
        changed = true;
      }
    }

    return changed;
  };

  const shouldDeliverWebhookForMessage = (message) => {
    const webhook = getSessionWebhookSettings(stores.sessions, message?.sessionId || "");

    if (!webhook.enabled || !webhook.url) {
      return false;
    }

    const kind = getConversationKind(message?.jid || "");

    if (message?.fromMe && !webhook.includeFromMe) {
      return false;
    }

    if (kind === "group") {
      return Boolean(webhook.allowGroups);
    }

    if (kind === "newsletter") {
      return Boolean(webhook.allowNewsletters);
    }

    if (kind === "broadcast") {
      return Boolean(webhook.allowBroadcasts);
    }

    return Boolean(webhook.allowPrivate);
  };

  const dispatchWebhookMessage = async (sessionId, message) => {
    if (!shouldDeliverWebhookForMessage(message)) {
      return;
    }

    const webhook = getSessionWebhookSettings(stores.sessions, sessionId);
    const conversation =
      getConversationMeta(stores, sessionId, message.jid) || normalizeConversationEntry({}, message.jid);
    const session = stores.sessions.sessions[sessionId] || ensureSessionMeta(stores.sessions, sessionId);
    const payload = {
      event: "message.created",
      emittedAt: new Date().toISOString(),
      session: {
        id: session.id,
        name: session.name,
      },
      conversation: buildConversationSummary(sessionId, conversation, stores),
      message: serializeMessageForClient(sessionId, message, stores),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 10000);

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-WhatsApp-Event": payload.event,
          "X-WhatsApp-Session": sessionId,
          ...(webhook.secret ? { "X-Webhook-Secret": webhook.secret } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        app.log.warn(
          {
            sessionId,
            statusCode: response.status,
            webhookUrl: webhook.url,
          },
          "Webhook respondeu com status nao esperado.",
        );
      }
    } catch (error) {
      app.log.warn({ error, sessionId, webhookUrl: webhook.url }, "Falha ao entregar webhook.");
    } finally {
      clearTimeout(timeout);
    }
  };

  const trimMessagesStore = () => {
    if (config.maxStoredMessages === Number.POSITIVE_INFINITY) {
      return;
    }

    const sessionsMap = {};
    for (const msg of stores.messages.messages) {
      if (!sessionsMap[msg.sessionId]) sessionsMap[msg.sessionId] = [];
      sessionsMap[msg.sessionId].push(msg);
    }

    let needsTrim = false;
    for (const sessionId of Object.keys(sessionsMap)) {
      if (sessionsMap[sessionId].length > config.maxStoredMessages) {
        needsTrim = true;
        break;
      }
    }

    if (!needsTrim) {
      return;
    }

    const keptMessages = [];
    const removedMessages = [];

    for (const sessionId of Object.keys(sessionsMap)) {
      const msgs = sessionsMap[sessionId];
      if (msgs.length > config.maxStoredMessages) {
        removedMessages.push(...msgs.slice(0, msgs.length - config.maxStoredMessages));
        keptMessages.push(...msgs.slice(msgs.length - config.maxStoredMessages));
      } else {
        keptMessages.push(...msgs);
      }
    }

    keptMessages.sort((a, b) => getMessageTimestampMs(a) - getMessageTimestampMs(b));

    removedMessages.forEach((message) => {
      messageIndex.delete(getMessageSignature(message));
    });

    stores.messages.messages = keptMessages;
  };

  const recordMessage = (sessionId, record, options = {}) => {
    const normalizedRecord = {
      ...record,
      sessionId,
      jid: record.jid || "",
    };
    const signature = getMessageSignature(normalizedRecord);

    if (messageIndex.has(signature)) {
      return normalizedRecord;
    }

    messageIndex.add(signature);
    stores.messages.messages.push(normalizedRecord);
    trimMessagesStore();
    upsertConversationFromMessage(stores, sessionId, normalizedRecord, {
      incrementUnread: options.incrementUnread ?? !normalizedRecord.fromMe,
      incrementCount: true,
    });

    const session = ensureSessionMeta(stores.sessions, sessionId);
    session.updatedAt = Math.max(
      Number(session.updatedAt || 0),
      getMessageTimestampMs(normalizedRecord),
    );

    if (!options.skipPersist) {
      void persistMessages();
      void persistConversations();
      void persistSessions();
    }

    return normalizedRecord;
  };

  const importHistorySync = async (sessionId, event, sock) => {
    let changed = false;
    let importedCount = 0;
    const contactsChanged = absorbContacts(sessionId, event.contacts || []);

    for (const chat of event.chats || []) {
      if (!chat?.id) {
        continue;
      }

      const conversation = ensureConversationMeta(stores, sessionId, chat.id);
      const chatName = typeof chat.name === "string" ? chat.name.trim() : "";
      if (chatName && conversation.title !== chatName) {
        conversation.title = chatName;
        changed = true;
      }

      const unreadCount = Number(chat.unreadCount);
      if (Number.isFinite(unreadCount) && unreadCount >= 0 && conversation.unreadCount !== unreadCount) {
        conversation.unreadCount = unreadCount;
        changed = true;
      }

      const conversationTimestamp = toStoreTimestampMs(chat.conversationTimestamp);
      if (conversationTimestamp && conversationTimestamp > Number(conversation.updatedAt || 0)) {
        conversation.updatedAt = conversationTimestamp;
        conversation.lastMessageAt = Math.max(
          Number(conversation.lastMessageAt || 0),
          conversationTimestamp,
        );
        changed = true;
      }

      for (const chatMessage of extractHistoryChatMessages(chat)) {
        const normalizedMessage = await normalizeIncomingMessage(sock, chatMessage);
        if (!normalizedMessage) {
          continue;
        }

        const previousIndexSize = messageIndex.size;
        recordMessage(sessionId, normalizedMessage, {
          skipPersist: true,
          incrementUnread: false,
        });

        if (messageIndex.size !== previousIndexSize) {
          importedCount += 1;
          changed = true;
        }
      }
    }

    for (const historyMessage of event.messages || []) {
      const normalizedMessage = await normalizeIncomingMessage(sock, historyMessage);
      if (!normalizedMessage) {
        continue;
      }

      const previousIndexSize = messageIndex.size;
      recordMessage(sessionId, normalizedMessage, {
        skipPersist: true,
        incrementUnread: false,
      });

      if (messageIndex.size !== previousIndexSize) {
        importedCount += 1;
        changed = true;
      }
    }

    if (changed || contactsChanged) {
      const session = ensureSessionMeta(stores.sessions, sessionId);
      session.updatedAt = Date.now();
      await Promise.all([persistMessages(), persistConversations(), persistSessions(), persistContacts()]);
    }

    app.log.info(
      {
        sessionId,
        importedCount,
        chatCount: event.chats?.length || 0,
        syncType: event.syncType ?? null,
        isLatest: event.isLatest ?? null,
      },
      "Historico sincronizado.",
    );

    return {
      importedCount,
      chatCount: event.chats?.length || 0,
      syncType: event.syncType ?? null,
      requestId: event.peerDataRequestSessionId || null,
    };
  };

  const createService = (sessionId) => {
    const sessionMeta = ensureSessionMeta(stores.sessions, sessionId);
    const sessionDir = path.join(config.sessionsDir, sessionId);
    const state = {
      socket: null,
      connectPromise: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      pendingHistoryRequests: new Map(),
      manualDisconnect: false,
      removed: false,
      status: "idle",
      qrDataUrl: null,
      connectedAt: null,
      lastDisconnectAt: null,
      lastError: null,
      me: null,
    };

    const getSnapshot = () => ({
      sessionId,
      status: state.status,
      qrAvailable: Boolean(state.qrDataUrl),
      qrDataUrl: state.qrDataUrl,
      connectedAt: state.connectedAt,
      lastDisconnectAt: state.lastDisconnectAt,
      lastError: state.lastError,
      reconnectAttempts: state.reconnectAttempts,
      me: serializeMe(state.me),
      accountId: getAccountId(state.me),
    });

    const clearReconnectTimer = () => {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
    };

    const rejectPendingHistoryRequests = (reason) => {
      for (const [requestId, pending] of state.pendingHistoryRequests.entries()) {
        pending.reject(new Error(reason || "Solicitacao de historico cancelada."));
        state.pendingHistoryRequests.delete(requestId);
      }
    };

    const scheduleReconnect = () => {
      if (state.manualDisconnect || state.reconnectTimer) {
        return;
      }

      const delayMs = Math.min(5_000 * (state.reconnectAttempts + 1), 30_000);
      state.reconnectAttempts += 1;

      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;
        void connect().catch((error) => {
          app.log.error({ error, sessionId }, "Falha ao reconectar sessao.");
        });
      }, delayMs);
    };

    const handleConnectionUpdate = async (update) => {
      if (state.removed) {
        return;
      }

      if (update.qr) {
        state.status = "qr";
        state.qrDataUrl = await QRCode.toDataURL(update.qr, {
          margin: 1,
          width: 320,
        });
      }

      if (update.connection === "open") {
        clearReconnectTimer();
        state.reconnectAttempts = 0;
        state.status = "connected";
        state.qrDataUrl = null;
        state.connectedAt = Date.now();
        state.lastError = null;
        state.me = state.socket?.user || null;
        sessionMeta.updatedAt = Date.now();
        void persistSessions();
        app.log.info({ sessionId }, "WhatsApp conectado.");
        return;
      }

      if (update.connection === "close") {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        state.socket = null;
        state.me = null;
        state.connectedAt = null;
        state.lastDisconnectAt = Date.now();
        state.lastError = errorToMessage(update.lastDisconnect?.error);
        state.status = loggedOut ? "logged_out" : "disconnected";
        state.qrDataUrl = null;

        if (!loggedOut) {
          scheduleReconnect();
        }
      }
    };

    const handleMessagesUpsert = async (event) => {
      if (state.removed) {
        return;
      }

      for (const message of event.messages || []) {
        const normalizedMessage = await normalizeIncomingMessage(state.socket, message);
        if (!normalizedMessage) {
          continue;
        }

        const signature = getMessageSignature({
          ...normalizedMessage,
          sessionId,
        });
        const isNewMessage = !messageIndex.has(signature);
        const storedMessage = recordMessage(sessionId, normalizedMessage);

        if (isNewMessage) {
          void dispatchWebhookMessage(sessionId, storedMessage);
          if (!storedMessage.fromMe) {
            // Emite usando o JID original da mensagem
            replyEmitter.emit(`reply_${sessionId}_${storedMessage.jid}`, storedMessage);

            // Tenta emitir usando todos os aliases conhecidos para este contato (resolve LID -> Telefone)
            const contact = getContactByAddress(stores.contacts, sessionId, storedMessage.jid);
            if (contact) {
              const aliases = [contact.jid, contact.lid, contact.id].filter(Boolean);
              for (const alias of aliases) {
                if (alias !== storedMessage.jid) {
                  replyEmitter.emit(`reply_${sessionId}_${alias}`, storedMessage);
                }
              }
            }
          }
        }
      }
    };

    const handleHistorySync = async (event) => {
      if (state.removed) {
        return;
      }

      const result = await importHistorySync(sessionId, event, state.socket);
      const requestId = result.requestId;

      if (requestId && state.pendingHistoryRequests.has(requestId)) {
        const pending = state.pendingHistoryRequests.get(requestId);
        state.pendingHistoryRequests.delete(requestId);
        pending.resolve(result);
      }
    };

    const handleContactsUpsert = async (contacts) => {
      if (state.removed || !Array.isArray(contacts) || !contacts.length) {
        return;
      }

      if (absorbContacts(sessionId, contacts)) {
        await persistContacts();
      }
    };

    const handleContactsUpdate = async (contacts) => {
      if (state.removed || !Array.isArray(contacts) || !contacts.length) {
        return;
      }

      const normalized = contacts.map((contact) => ({
        id: contact.id || contact.lid || contact.jid || "",
        lid: contact.lid || null,
        jid: contact.jid || null,
        name: contact.name || null,
        notify: contact.notify || null,
        verifiedName: contact.verifiedName || null,
        imgUrl: contact.imgUrl,
        status: contact.status || null,
      }));

      if (absorbContacts(sessionId, normalized)) {
        await persistContacts();
      }
    };

    const handleGroupsUpsert = async (groups) => {
      if (state.removed || !Array.isArray(groups) || !groups.length) return;
      let changed = false;
      for (const group of groups) {
        if (!group?.id) continue;

        // Push group to contacts to make sure getPreferredContactName can find it
        if (typeof group.subject === "string" && group.subject.trim()) {
           absorbContacts(sessionId, [{ id: group.id, subject: group.subject.trim(), name: group.subject.trim() }]);
        }

        const conversation = ensureConversationMeta(stores, sessionId, group.id);
        const name = typeof group.subject === "string" ? group.subject.trim() : "";
        if (name && conversation.title !== name) {
          conversation.title = name;
          changed = true;
        }
      }
      if (changed) void persistConversations();
    };

    const handleGroupsUpdate = async (groups) => {
      if (state.removed || !Array.isArray(groups) || !groups.length) return;
      let changed = false;
      for (const group of groups) {
        if (!group?.id) continue;

        // Push group to contacts to make sure getPreferredContactName can find it
        if (typeof group.subject === "string" && group.subject.trim()) {
           absorbContacts(sessionId, [{ id: group.id, subject: group.subject.trim(), name: group.subject.trim() }]);
        }

        const conversation = ensureConversationMeta(stores, sessionId, group.id);
        const name = typeof group.subject === "string" ? group.subject.trim() : "";
        if (name && conversation.title !== name) {
          conversation.title = name;
          changed = true;
        }
      }
      if (changed) void persistConversations();
    };

    const handleChatsUpsert = async (chats) => {
      if (state.removed || !Array.isArray(chats) || !chats.length) return;
      let changed = false;
      for (const chat of chats) {
        if (!chat?.id) continue;

        if (typeof chat.name === "string" && chat.name.trim()) {
           absorbContacts(sessionId, [{ id: chat.id, name: chat.name.trim() }]);
        }

        const conversation = ensureConversationMeta(stores, sessionId, chat.id);
        const name = typeof chat.name === "string" ? chat.name.trim() : "";
        if (name && conversation.title !== name) {
          conversation.title = name;
          changed = true;
        }
      }
      if (changed) void persistConversations();
    };

    const handleChatsUpdate = async (chats) => {
      if (state.removed || !Array.isArray(chats) || !chats.length) return;
      let changed = false;
      for (const chat of chats) {
        if (!chat?.id) continue;

        if (typeof chat.name === "string" && chat.name.trim()) {
           absorbContacts(sessionId, [{ id: chat.id, name: chat.name.trim() }]);
        }

        const conversation = ensureConversationMeta(stores, sessionId, chat.id);
        const name = typeof chat.name === "string" ? chat.name.trim() : "";
        if (name && conversation.title !== name) {
          conversation.title = name;
          changed = true;
        }
      }
      if (changed) void persistConversations();
    };

    const handlePhoneNumberShare = async (share) => {
      if (state.removed || !share?.lid || !share?.jid) {
        return;
      }

      if (
        absorbContacts(sessionId, [
          {
            id: share.lid,
            lid: share.lid,
            jid: share.jid,
          },
        ])
      ) {
        await persistContacts();
      }
    };

    const connect = async () => {
      if (state.removed) {
        throw new Error("Sessao foi removida.");
      }

      if (state.connectPromise) {
        return state.connectPromise;
      }

      if (state.socket && state.status === "connected") {
        return getSnapshot();
      }

      clearReconnectTimer();
      state.manualDisconnect = false;
      state.status = "connecting";
      state.lastError = null;

      state.connectPromise = (async () => {
        await fs.mkdir(sessionDir, { recursive: true });
        const { state: authState, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const socket = makeWASocket({
          version,
          auth: {
            creds: authState.creds,
            keys: makeCacheableSignalKeyStore(authState.keys, logger),
          },
          browser: Browsers.macOS("Desktop"),
          syncFullHistory: config.syncFullHistory,
          shouldSyncHistoryMessage: () => true,
          printQRInTerminal: false,
          markOnlineOnConnect: false,
          generateHighQualityLinkPreview: false,
          logger,
        });

        state.socket = socket;
        state.me = socket.user || null;

        socket.ev.on("creds.update", saveCreds);
        socket.ev.on("connection.update", (update) => {
          void handleConnectionUpdate(update);
        });
        socket.ev.on("messaging-history.set", (event) => {
          void handleHistorySync(event);
        });
        socket.ev.on("contacts.upsert", (contacts) => {
          void handleContactsUpsert(contacts);
        });
        socket.ev.on("contacts.update", (contacts) => {
          void handleContactsUpdate(contacts);
        });
        socket.ev.on("groups.upsert", (groups) => {
          void handleGroupsUpsert(groups);
        });
        socket.ev.on("groups.update", (groups) => {
          void handleGroupsUpdate(groups);
        });
        socket.ev.on("chats.upsert", (chats) => {
          void handleChatsUpsert(chats);
        });
        socket.ev.on("chats.update", (chats) => {
          void handleChatsUpdate(chats);
        });
        socket.ev.on("chats.phoneNumberShare", (share) => {
          void handlePhoneNumberShare(share);
        });
        socket.ev.on("messages.upsert", (event) => {
          void handleMessagesUpsert(event);
        });

        return getSnapshot();
      })().finally(() => {
        state.connectPromise = null;
      });

      return state.connectPromise;
    };

    const disconnect = async () => {
      state.manualDisconnect = true;
      clearReconnectTimer();
      rejectPendingHistoryRequests("Sessao desconectada.");

      if (state.socket?.ws?.close) {
        try {
          state.socket.ws.close();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Falha ao fechar websocket da sessao.");
        }
      }

      state.socket = null;
      state.me = null;
      state.status = "disconnected";
      state.qrDataUrl = null;
      state.connectedAt = null;
      state.lastDisconnectAt = Date.now();

      return getSnapshot();
    };

    const logout = async () => {
      state.manualDisconnect = true;
      clearReconnectTimer();
      rejectPendingHistoryRequests("Sessao resetada.");

      if (state.socket) {
        try {
          await state.socket.logout();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Falha ao fazer logout da sessao.");
        }
      }

      await fs.rm(sessionDir, { recursive: true, force: true });
      await fs.mkdir(sessionDir, { recursive: true });

      state.socket = null;
      state.me = null;
      state.status = "logged_out";
      state.qrDataUrl = null;
      state.connectedAt = null;
      state.lastDisconnectAt = Date.now();
      state.lastError = null;

      return getSnapshot();
    };

    const destroy = async () => {
      state.removed = true;
      state.manualDisconnect = true;
      clearReconnectTimer();
      rejectPendingHistoryRequests("Sessao removida.");

      if (state.socket) {
        try {
          await state.socket.logout();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Falha ao fazer logout da sessao removida.");
        }
      }

      if (state.socket?.ws?.close) {
        try {
          state.socket.ws.close();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Falha ao fechar websocket da sessao removida.");
        }
      }

      state.socket = null;
      state.me = null;
      state.status = "disconnected";
      state.qrDataUrl = null;
      state.connectedAt = null;
      state.lastDisconnectAt = Date.now();
      state.lastError = null;

      await fs.rm(sessionDir, { recursive: true, force: true });
    };

    const verifyNumberExists = async (jid) => {
      if (jid.endsWith('@lid') || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
        return jid;
      }

      // 1. Check if the JID is already known in our conversations or contacts store
      // to avoid redundant network queries for already active contacts (which can fail/disconnect)
      const cleanJid = jid.split('@')[0];
      const conversationBucket = ensureConversationBucket(stores.conversations, sessionId);
      const knownConvo = conversationBucket[jid] || conversationBucket[cleanJid];
      if (knownConvo) {
        return knownConvo.jid;
      }

      const contactBucket = ensureContactBucket(stores.contacts, sessionId);
      const knownContact = contactBucket.records[jid] || contactBucket.records[cleanJid] || getContactByAddress(stores.contacts, sessionId, jid);
      if (knownContact) {
        return knownContact.jid || jid;
      }

      const checkJid = async (targetJid) => {
        try {
          app.log.info({ sessionId, targetJid }, "Verificando se o numero existe no WhatsApp via onWhatsApp...");
          const checkResult = await state.socket.onWhatsApp(targetJid);
          if (checkResult && checkResult.length > 0) {
            const [existsResult] = checkResult;
            if (existsResult && existsResult.exists) {
              app.log.info({ sessionId, targetJid, resolvedJid: existsResult.jid }, "Numero verificado com sucesso no WhatsApp.");
              return existsResult.jid;
            }
          }
          app.log.info({ sessionId, targetJid }, "Numero nao existe no WhatsApp.");
        } catch (e) {
          app.log.error({ sessionId, targetJid, error: e }, "Erro ao executar onWhatsApp.");
        }
        return null;
      };

      try {
        const resolved = await checkJid(jid);
        if (resolved) return resolved;

        const brMatch = jid.match(/^55(\d{2})(\d+)(@s\.whatsapp\.net)$/);
        if (brMatch) {
          const ddd = brMatch[1];
          const number = brMatch[2];
          let altJid = null;

          if (number.length === 9 && number.startsWith("9")) {
            altJid = `55${ddd}${number.slice(1)}@s.whatsapp.net`;
          } else if (number.length === 8) {
            altJid = `55${ddd}9${number}@s.whatsapp.net`;
          }

          if (altJid) {
            app.log.info({ sessionId, jid, altJid }, "Tentando alternativa de 8/9 digitos para numero brasileiro...");
            const altResolved = await checkJid(altJid);
            if (altResolved) {
              app.log.info({ sessionId, jid, altResolved }, "Alternativa de 8/9 digitos encontrada e resolvida.");
              return altResolved;
            }
          }
        }

        throw new Error("O numero informado nao esta registrado no WhatsApp.");
      } catch (checkErr) {
        if (checkErr.message.includes("nao esta registrado")) {
          throw checkErr;
        }
        app.log.warn({ sessionId, error: checkErr, jid }, "Falha ao verificar numero via onWhatsApp. Prosseguindo com o original.");
        return jid;
      }
    };

    const resolveLid = async (phone) => {
      if (!state.socket || state.status !== "connected") {
        throw new Error("Sessao nao esta conectada.");
      }

      let rawJid = phone;
      if (!phone.includes("@")) {
        rawJid = normalizeJidInput(phone);
      }

      if (rawJid.endsWith('@lid')) {
        return { exists: true, jid: rawJid, lid: rawJid };
      }

      const contactBucket = ensureContactBucket(stores.contacts, sessionId);
      const knownContact = getContactByAddress(stores.contacts, sessionId, rawJid);
      if (knownContact && knownContact.lid) {
        app.log.info({ sessionId, phone, lid: knownContact.lid }, "LID resolvido a partir do cache local.");
        return {
          exists: true,
          jid: knownContact.jid || rawJid,
          lid: knownContact.lid
        };
      }

      try {
        app.log.info({ sessionId, rawJid }, "Resolvendo LID no WhatsApp via onWhatsApp...");
        const checkResult = await state.socket.onWhatsApp(rawJid);
        if (checkResult && checkResult.length > 0) {
          const [existsResult] = checkResult;
          if (existsResult && existsResult.exists && existsResult.lid) {
            app.log.info({ sessionId, rawJid, lid: existsResult.lid }, "LID resolvido com sucesso via USync.");
            
            const contactData = {
              id: existsResult.jid,
              jid: existsResult.jid,
              lid: existsResult.lid
            };
            
            const changed = upsertContact(stores.contacts, sessionId, contactData);
            if (changed) {
              await persistContacts();
            }

            return {
              exists: true,
              jid: existsResult.jid,
              lid: existsResult.lid
            };
          }
        }

        app.log.info({ sessionId, rawJid }, "Numero nao existe ou nao retornou LID no WhatsApp.");
        return {
          exists: false,
          message: "O numero informado nao esta registrado no WhatsApp."
        };
      } catch (e) {
        app.log.error({ sessionId, rawJid, error: e }, "Erro ao executar resolveLid via onWhatsApp.");
        throw e;
      }
    };

    const sendText = async (jidInput, text) => {
      if (!state.socket || state.status !== "connected") {
        throw new Error("Sessao nao esta conectada.");
      }

      const rawJid = normalizeJidInput(jidInput);
      const jid = await verifyNumberExists(rawJid);
      const response = await state.socket.sendMessage(jid, { text });
      const storedMessage = recordMessage(sessionId, {
        id: response?.key?.id || `local_${Date.now()}`,
        jid,
        fromMe: true,
        text,
        timestamp: Math.floor(Date.now() / 1000),
        type: "text",
        status: "sent",
        pushName: state.me?.name || state.me?.verifiedName || null,
        participant: null,
        media: null,
      });

      void dispatchWebhookMessage(sessionId, storedMessage);

      return storedMessage;
    };

    const sendMedia = async (jidInput, payload) => {
      if (!state.socket || state.status !== "connected") {
        throw new Error("Sessao nao esta conectada.");
      }

      const rawJid = normalizeJidInput(jidInput);
      const jid = await verifyNumberExists(rawJid);
      const prepared = prepareOutgoingMediaPayload(payload);
      const response = await state.socket.sendMessage(jid, prepared.content);
      const messageId = response?.key?.id || `local_${Date.now()}`;
      const cachedMedia = prepared.buffer
        ? await cacheMediaBuffer({
            buffer: prepared.buffer,
            config,
            sessionId,
            messageId,
            media: payload.media,
          })
        : null;

      const storedMessage = recordMessage(sessionId, {
        id: messageId,
        jid,
        fromMe: true,
        text: payload.text || "",
        timestamp: Math.floor(Date.now() / 1000),
        type: payload.media.kind,
        status: "sent",
        pushName: state.me?.name || state.me?.verifiedName || null,
        participant: null,
        media: buildOutgoingStoredMedia(payload.media, cachedMedia),
      });

      void dispatchWebhookMessage(sessionId, storedMessage);

      return storedMessage;
    };

    const resolveMessageMedia = async (message) => {
      const existingFilePath = getCachedMediaAbsolutePath(config, message.media);
      if (existingFilePath && existsSync(existingFilePath)) {
        return {
          filePath: existingFilePath,
          mimeType: message.media?.mimeType || "application/octet-stream",
        };
      }

      if (!message.media?.download) {
        throw new Error("A midia desta mensagem nao esta disponivel.");
      }

      const waMessage = buildMediaDownloadMessage(message);
      const context = state.socket
        ? {
            logger,
            reuploadRequest: (staleMessage) => state.socket.updateMediaMessage(staleMessage),
          }
        : undefined;
      let buffer;
      try {
        buffer = await downloadMediaMessage(waMessage, "buffer", {}, context);
      } catch (err) {
        app.log.error({ sessionId, error: err, messageId: message.id }, "Erro ao baixar media do WhatsApp.");
        throw new Error("Falha ao processar downloadMediaMessage: " + err.message);
      }
      const cachedMedia = await cacheMediaBuffer({
        buffer,
        config,
        sessionId,
        messageId: message.id,
        media: message.media,
      });

      message.media.cachePath = cachedMedia.relativePath;
      message.media.fileName = message.media.fileName || path.basename(cachedMedia.filePath);
      await persistMessages();

      return {
        filePath: cachedMedia.filePath,
        mimeType: message.media?.mimeType || "application/octet-stream",
      };
    };

    const loadOlderMessages = async (jid, count = 80) => {
      if (!state.socket || state.status !== "connected") {
        throw new Error("Conecte a sessao para buscar mensagens antigas.");
      }

      const oldestMessage = getConversationMessages(sessionId, jid, stores)[0];
      if (!oldestMessage) {
        return {
          requestId: null,
          importedCount: 0,
          requiresBootstrap: true,
        };
      }

      const messageKey = {
        remoteJid: oldestMessage.jid,
        fromMe: Boolean(oldestMessage.fromMe),
        id: oldestMessage.id,
        participant: oldestMessage.participant || undefined,
      };

      const requestId = await state.socket.fetchMessageHistory(
        count,
        messageKey,
        getMessageTimestampMs(oldestMessage),
      );

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          state.pendingHistoryRequests.delete(requestId);
          reject(new Error("O WhatsApp nao retornou mais mensagens antigas a tempo."));
        }, 15000);

        state.pendingHistoryRequests.set(requestId, {
          resolve: (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
      });
    };

    return {
      connect,
      disconnect,
      logout,
      destroy,
      loadOlderMessages,
      resolveMessageMedia,
      sendMedia,
      sendText,
      getSnapshot,
      verifyNumberExists,
      resolveLid,
    };
  };

  const getService = (sessionId) => {
    if (!services.has(sessionId)) {
      services.set(sessionId, createService(sessionId));
    }

    return services.get(sessionId);
  };

  const getSessionSummary = (sessionId) => {
    const meta = stores.sessions.sessions[sessionId];
    if (!meta) {
      return null;
    }

    return {
      id: meta.id,
      name: meta.name,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      snapshot: getService(sessionId).getSnapshot(),
      stats: getSessionStats(sessionId, stores),
    };
  };

  const listSessions = () =>
    Object.values(stores.sessions.sessions)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map((session) => getSessionSummary(session.id))
      .filter(Boolean);

  const createSession = async (name) => {
    const sessionId = generateSessionId(name, stores.sessions);
    const session = ensureSessionMeta(stores.sessions, sessionId, {
      name: String(name).trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    session.webhook = cloneWebhookSettings(stores.settings.webhook);
    ensureConversationBucket(stores.conversations, sessionId);
    ensureContactBucket(stores.contacts, sessionId);

    await fs.mkdir(path.join(config.sessionsDir, sessionId), { recursive: true });
    await Promise.all([persistSessions(), persistConversations(), persistContacts()]);

    return getSessionSummary(sessionId);
  };

  const removeSession = async (sessionId) => {
    const service = services.get(sessionId);

    if (service) {
      await service.destroy();
      services.delete(sessionId);
    } else {
      await fs.rm(path.join(config.sessionsDir, sessionId), { recursive: true, force: true });
    }

    const keptMessages = [];
    for (const message of stores.messages.messages) {
      if (message.sessionId === sessionId) {
        messageIndex.delete(getMessageSignature(message));
        continue;
      }

      keptMessages.push(message);
    }

    stores.messages.messages = keptMessages;
    delete stores.conversations.sessions[sessionId];
    delete stores.sessions.sessions[sessionId];
    delete stores.contacts.sessions[sessionId];

    await fs.rm(path.join(config.mediaDir, sessionId), { recursive: true, force: true });

    await Promise.all([persistMessages(), persistConversations(), persistSessions(), persistContacts()]);
    return sessionId;
  };

  const autoConnectExistingSessions = async () => {
    const summaries = listSessions();

    for (const session of summaries) {
      if (await hasSessionAuthFiles(path.join(config.sessionsDir, session.id))) {
        void getService(session.id).connect().catch((error) => {
          app.log.error({ error, sessionId: session.id }, "Falha ao conectar sessao existente.");
        });
      }
    }
  };

  const disconnectAll = async () => {
    const sessionIds = Object.keys(stores.sessions.sessions);
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await getService(sessionId).disconnect();
        } catch (error) {
          app.log.warn({ error, sessionId }, "Falha ao encerrar sessao no shutdown.");
        }
      }),
    );
  };

  return {
    hasSession: (sessionId) => Boolean(stores.sessions.sessions[sessionId]),
    getSessionSummary,
    listSessions,
    createSession,
    connect: async (sessionId) => getService(sessionId).connect(),
    disconnect: async (sessionId) => getService(sessionId).disconnect(),
    logout: async (sessionId) => getService(sessionId).logout(),
    loadOlderMessages: async (sessionId, jid, count) => getService(sessionId).loadOlderMessages(jid, count),
    removeSession,
    resolveMessageMedia: async (sessionId, message) => getService(sessionId).resolveMessageMedia(message),
    sendMedia: async (sessionId, jid, payload) => getService(sessionId).sendMedia(jid, payload),
    sendText: async (sessionId, jid, text) => getService(sessionId).sendText(jid, text),
    verifyNumberExists: async (sessionId, jid) => getService(sessionId).verifyNumberExists(jid),
    resolveLid: async (sessionId, phone) => getService(sessionId).resolveLid(phone),
    autoConnectExistingSessions,
    disconnectAll,
    dispatchWebhookMessage,
  };
}

function listSessionConversations(sessionId, stores, { limit, search, kind }) {
  const bucket = ensureConversationBucket(stores.conversations, sessionId);

  // We use Object.values and then filter unique jids to prevent any duplicates just in case
  const values = Object.values(bucket);
  const uniqueConversations = Array.from(new Map(values.map(c => [c.jid, c])).values());

  return uniqueConversations
    .map((conversation) => buildConversationSummary(sessionId, conversation, stores))
    .filter((conversation) => {
      if (kind === "private") {
        if (conversation.kind !== "private" && conversation.kind !== "group") {
          return false;
        }
      }
      if (kind === "status") {
        if (conversation.kind !== "newsletter" && conversation.kind !== "broadcast") {
          return false;
        }
      }

      if (!search) {
        return true;
      }

      return [
        conversation.title,
        conversation.jid,
        conversation.displayJid,
        conversation.preview,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    .slice(0, limit);
}

function getConversationMessages(sessionId, jid, stores) {
  return stores.messages.messages
    .filter((message) => message.sessionId === sessionId && message.jid === jid)
    .sort((left, right) => getMessageTimestampMs(left) - getMessageTimestampMs(right));
}

function getConversationMessagesPage(sessionId, jid, stores, { limit, beforeId }) {
  const messages = getConversationMessages(sessionId, jid, stores);
  const safeLimit = Math.max(1, Number(limit || 120));

  let endIndex = messages.length;
  if (beforeId) {
    const foundIndex = messages.findIndex((message) => message.id === beforeId);
    endIndex = foundIndex >= 0 ? foundIndex : messages.length;
  }

  const startIndex = Math.max(0, endIndex - safeLimit);
  const pageMessages = messages.slice(startIndex, endIndex);

  return {
    messages: pageMessages,
    hasOlder: startIndex > 0,
    oldestMessageId: pageMessages[0]?.id || null,
    newestMessageId: pageMessages.at(-1)?.id || null,
  };
}

function getSessionStats(sessionId, stores) {
  const conversations = listSessionConversations(sessionId, stores, {
    limit: Number.MAX_SAFE_INTEGER,
    search: "",
  });
  const messages = stores.messages.messages.filter((message) => message.sessionId === sessionId);

  return {
    conversationCount: conversations.length,
    messageCount: messages.length,
    unreadCount: conversations.reduce((total, conversation) => total + Number(conversation.unreadCount || 0), 0),
    groupCount: conversations.filter((conversation) => conversation.kind === "group").length,
    privateCount: conversations.filter((conversation) => conversation.kind === "private").length,
  };
}

function getGlobalStats(stores) {
  const sessionIds = Object.keys(stores.sessions.sessions);
  return sessionIds.reduce(
    (totals, sessionId) => {
      const stats = getSessionStats(sessionId, stores);
      totals.sessionCount += 1;
      totals.conversationCount += stats.conversationCount;
      totals.messageCount += stats.messageCount;
      totals.unreadCount += stats.unreadCount;
      return totals;
    },
    {
      sessionCount: 0,
      conversationCount: 0,
      messageCount: 0,
      unreadCount: 0,
    },
  );
}

function buildConversationSummary(sessionId, conversation, stores) {
  const identity = resolveConversationIdentity(stores, sessionId, conversation.jid, conversation.title);

  return {
    jid: conversation.jid,
    displayJid: identity.displayJid,
    title: identity.title,
    kind: getConversationKind(conversation.jid),
    updatedAt: Number(conversation.updatedAt || Date.now()),
    unreadCount: Number(conversation.unreadCount || 0),
    preview: conversation.preview || "",
    lastMessageAt: Number(conversation.lastMessageAt || conversation.updatedAt || Date.now()),
    lastMessageTimestamp: Math.floor(Number(conversation.lastMessageAt || conversation.updatedAt || Date.now()) / 1000),
    messageCount: Number(conversation.messageCount || 0),
    imgUrl: identity.contact?.imgUrl || null,
  };
}

function serializeMessageForClient(sessionId, message, stores) {
  const identity = resolveConversationIdentity(stores, sessionId, message.jid);
  const participantIdentity = message.participant
    ? resolveConversationIdentity(stores, sessionId, message.participant)
    : null;

  return {
    id: message.id,
    jid: message.jid,
    resolvedJid: identity.resolvedJid, // Retorna o telefone resolvido se for @lid
    displayJid: identity.displayJid,
    fromMe: Boolean(message.fromMe),
    text: message.text || "",
    timestamp: normalizeTimestamp(message.timestamp),
    type: message.type || "text",
    status: message.status || "stored",
    pushName: message.pushName || null,
    participant: message.participant || null,
    participantDisplayJid: participantIdentity?.displayJid || null,
    media: serializeMediaForClient(sessionId, message),
  };
}

function serializeMediaForClient(sessionId, message) {
  if (!message?.media) {
    return null;
  }

  return {
    kind: message.media.kind,
    mimeType: message.media.mimeType || "application/octet-stream",
    fileName: message.media.fileName || null,
    fileSize: Number(message.media.fileSize || 0) || null,
    width: Number(message.media.width || 0) || null,
    height: Number(message.media.height || 0) || null,
    seconds: Number(message.media.seconds || 0) || null,
    isAnimated: Boolean(message.media.isAnimated),
    url: `/api/sessions/${encodeURIComponent(sessionId)}/media?messageId=${encodeURIComponent(message.id)}`,
  };
}

function findStoredMessage(sessionId, messageId, stores) {
  return (
    stores.messages.messages.find(
      (message) => message.sessionId === sessionId && String(message.id) === String(messageId),
    ) || null
  );
}

function sendMediaFileResponse(reply, filePath, mimeType) {
  reply.header("Cache-Control", "private, max-age=604800");
  reply.type(mimeType || "application/octet-stream");
  return reply.send(createReadStream(filePath));
}

function upsertConversationFromMessage(stores, sessionId, record, options = {}) {
  const conversation = ensureConversationMeta(stores, sessionId, record.jid);
  const timestampMs = getMessageTimestampMs(record);

  conversation.title = conversation.title || record.pushName || formatJidForDisplay(record.jid);
  conversation.kind = getConversationKind(record.jid);
  conversation.updatedAt = timestampMs;
  conversation.lastMessageAt = timestampMs;
  conversation.preview = getMessagePreview(record);

  if (options.incrementCount) {
    conversation.messageCount = Number(conversation.messageCount || 0) + 1;
  }

  if (options.incrementUnread && !record.fromMe) {
    conversation.unreadCount = Number(conversation.unreadCount || 0) + 1;
  }

  return conversation;
}

function rebuildConversationsFromMessages(stores) {
  const previousStore = stores.conversations;
  const rebuilt = { sessions: {} };

  for (const sessionId of Object.keys(stores.sessions.sessions)) {
    ensureConversationBucket(rebuilt, sessionId);
  }

  for (const [sessionId, sessionData] of Object.entries(previousStore.sessions || {})) {
    const bucket = ensureConversationBucket(rebuilt, sessionId);
    for (const [jid, conversation] of Object.entries(sessionData.conversations || {})) {
      bucket[jid] = normalizeConversationEntry(conversation, jid);
      bucket[jid].messageCount = 0;
    }
  }

  const sortedMessages = [...stores.messages.messages].sort(
    (left, right) => getMessageTimestampMs(left) - getMessageTimestampMs(right),
  );

  for (const message of sortedMessages) {
    const sessionId = message.sessionId || DEFAULT_SESSION_ID;
    ensureSessionMeta(stores.sessions, sessionId, {
      name: sessionId === DEFAULT_SESSION_ID ? "Sessao principal" : formatSessionName(sessionId),
    });
    upsertConversationFromMessage(
      { ...stores, conversations: rebuilt },
      sessionId,
      message,
      { incrementCount: true },
    );
  }

  stores.conversations = rebuilt;
}

function ensureConversationBucket(store, sessionId) {
  if (!store.sessions) {
    store.sessions = {};
  }

  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = { conversations: {} };
  }

  if (!store.sessions[sessionId].conversations) {
    store.sessions[sessionId].conversations = {};
  }

  return store.sessions[sessionId].conversations;
}

function ensureConversationMeta(stores, sessionId, jid) {
  const bucket = ensureConversationBucket(stores.conversations, sessionId);

  if (!bucket[jid]) {
    bucket[jid] = normalizeConversationEntry({}, jid);
  }

  return bucket[jid];
}

function getConversationMeta(stores, sessionId, jid) {
  return ensureConversationBucket(stores.conversations, sessionId)[jid] || null;
}

function extractHistoryChatMessages(chat) {
  if (!Array.isArray(chat?.messages)) {
    return [];
  }

  return chat.messages
    .map((entry) => entry?.message || entry)
    .filter(Boolean);
}

function extractMediaDescriptor(content) {
  if (!content || typeof content !== "object") {
    return null;
  }

  const definitions = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ];

  for (const [messageType, kind] of definitions) {
    const mediaMessage = content[messageType];
    if (!mediaMessage) {
      continue;
    }

    return {
      kind,
      mimeType: mediaMessage.mimetype || defaultMimeTypeForMediaKind(kind),
      fileName: mediaMessage.fileName || null,
      fileSize: Number(mediaMessage.fileLength || 0) || null,
      width: Number(mediaMessage.width || 0) || null,
      height: Number(mediaMessage.height || 0) || null,
      seconds: Number(mediaMessage.seconds || 0) || null,
      isAnimated: Boolean(mediaMessage.isAnimated),
      cachePath: null,
      download: normalizeStoredDownloadSource(kind, mediaMessage),
    };
  }

  return null;
}

async function normalizeIncomingMessage(sock, message) {
  let jid = message?.key?.remoteJid;
  let pushName = message?.pushName || 'Desconhecido';

  if (!jid || !message?.message) {
    return null;
  }

  // Mantém o jid como o ID do grupo para que a conversa não seja dividida,
  // mas o participant continua sendo salvo mais abaixo em message.key.participant.
  // if (jid.endsWith('@g.us') && message.key.participant) {
  //   jid = message.key.participant;
  // }

  // Remove the device suffix locally. We avoid using sock.onWhatsApp here because
  // executing queries during history sync overloads the connection and triggers
  // WhatsApp's rate limit / connection close.
  // We keep the domain suffix (@s.whatsapp.net, @g.us, etc) for conversation kind detection.
  if (jid.includes(':')) {
    const parts = jid.split('@');
    const cleanUser = parts[0].split(':')[0];
    jid = parts[1] ? `${cleanUser}@${parts[1]}` : cleanUser;
  }

  // To prevent breaking history indexing while allowing getConversationKind to function correctly elsewhere,
  // we remove the suffix here for the core index. The `message.key.remoteJid` is already used by Baileys
  // and we parse it properly for UI representation later.
  jid = jid.split('@')[0].split(':')[0];

  const content = unwrapMessageContent(message.message);
  const type = extractMessageType(content);
  const text = extractMessageText(content);
  const media = extractMediaDescriptor(content);

  if (
    ["senderKeyDistributionMessage", "messageContextInfo", "protocolMessage"].includes(type) &&
    !text
  ) {
    return null;
  }

  return {
    id: message.key.id || `incoming_${Date.now()}`,
    jid,
    fromMe: Boolean(message.key.fromMe),
    text,
    timestamp: normalizeTimestamp(message.messageTimestamp),
    type,
    status: "received",
    pushName: pushName,
    participant: message.key.participant || null,
    media,
  };
}

function unwrapMessageContent(message) {
  if (!message) {
    return null;
  }

  if (message.ephemeralMessage?.message) {
    return unwrapMessageContent(message.ephemeralMessage.message);
  }

  if (message.viewOnceMessage?.message) {
    return unwrapMessageContent(message.viewOnceMessage.message);
  }

  if (message.viewOnceMessageV2?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2.message);
  }

  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessageContent(message.viewOnceMessageV2Extension.message);
  }

  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessageContent(message.documentWithCaptionMessage.message);
  }

  if (message.deviceSentMessage?.message) {
    return unwrapMessageContent(message.deviceSentMessage.message);
  }

  if (message.editedMessage?.message) {
    return unwrapMessageContent(message.editedMessage.message);
  }

  return message;
}

function extractMessageType(content) {
  if (!content || typeof content !== "object") {
    return "unknown";
  }

  return Object.keys(content)[0] || "unknown";
}

function extractMessageText(content) {
  if (!content || typeof content !== "object") {
    return "";
  }

  if (typeof content.conversation === "string") {
    return content.conversation;
  }

  if (typeof content.extendedTextMessage?.text === "string") {
    return content.extendedTextMessage.text;
  }

  if (typeof content.imageMessage?.caption === "string") {
    return content.imageMessage.caption;
  }

  if (typeof content.videoMessage?.caption === "string") {
    return content.videoMessage.caption;
  }

  if (typeof content.documentMessage?.caption === "string") {
    return content.documentMessage.caption;
  }

  if (typeof content.buttonsResponseMessage?.selectedDisplayText === "string") {
    return content.buttonsResponseMessage.selectedDisplayText;
  }

  if (typeof content.listResponseMessage?.title === "string") {
    return content.listResponseMessage.title;
  }

  if (typeof content.templateButtonReplyMessage?.selectedDisplayText === "string") {
    return content.templateButtonReplyMessage.selectedDisplayText;
  }

  if (typeof content.pollCreationMessage?.name === "string") {
    return content.pollCreationMessage.name;
  }

  if (content.locationMessage) {
    return "[localizacao]";
  }

  if (content.contactMessage?.displayName) {
    return `[contato] ${content.contactMessage.displayName}`;
  }

  if (content.stickerMessage) {
    return "[sticker]";
  }

  if (content.audioMessage) {
    return "[audio]";
  }

  if (content.imageMessage) {
    return "[imagem]";
  }

  if (content.videoMessage) {
    return "[video]";
  }

  if (content.documentMessage) {
    return "[documento]";
  }

  return "";
}

function normalizeTimestamp(value) {
  const numeric = Number(value || Date.now());

  if (!Number.isFinite(numeric)) {
    return Math.floor(Date.now() / 1000);
  }

  if (numeric > 1_000_000_000_000) {
    return Math.floor(numeric / 1000);
  }

  return Math.floor(numeric);
}

function toStoreTimestampMs(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return numeric > 1_000_000_000_000 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function getMessageTimestampMs(message) {
  const timestamp = normalizeTimestamp(message?.timestamp);
  return timestamp * 1000;
}

function getMessagePreview(message) {
  if (!message) {
    return "";
  }

  if (message.text) {
    return message.text;
  }

  return `[${message.type || "mensagem"}]`;
}

function getMessageSignature(message) {
  return [
    message.sessionId || DEFAULT_SESSION_ID,
    message.id || "",
    message.jid || "",
    message.fromMe ? "1" : "0",
  ].join(":");
}

function getConversationKind(jid = "") {
  // If the jid doesn't contain an @ domain (because it was stripped earlier in normalizeIncomingMessage),
  // we try to infer based on length, though most times groups have `-` and broadcasts usually are `status`.
  if (jid.endsWith("@g.us") || jid.includes("-")) {
    return "group";
  }

  if (jid.endsWith("@newsletter")) {
    return "newsletter";
  }

  if (jid.endsWith("@broadcast") || jid === "status@broadcast" || jid.includes("broadcast") || jid === "status") {
    return "broadcast";
  }

  return "private";
}

function resolveConversationIdentity(stores, sessionId, jid, fallbackTitle = "") {
  const kind = getConversationKind(jid);
  // We want to fetch contacts for all types to ensure we get group/newsletter names
  const contact = getContactByAddress(stores.contacts, sessionId, jid);
  const resolvedJid = getPreferredContactAddress(contact, jid);
  const displayJid = formatJidForDisplay(resolvedJid);
  const genericFallback = formatJidForDisplay(jid);
  const rawFallback = String(fallbackTitle || "").trim();
  const preferredName = getPreferredContactName(contact);
  const preservedTitle =
    rawFallback && rawFallback !== jid && rawFallback !== genericFallback && rawFallback !== displayJid
      ? rawFallback
      : "";

  return {
    contact,
    resolvedJid,
    displayJid,
    title: preferredName || preservedTitle || displayJid,
  };
}

function getPreferredContactName(contact) {
  if (!contact) {
    return "";
  }

  return String(contact.name || contact.notify || contact.verifiedName || contact.subject || "").trim();
}

function getPreferredContactAddress(contact, fallbackJid) {
  if (!contact) {
    return fallbackJid;
  }

  const preferred = [contact.jid, contact.id, contact.lid]
    .map((value) => String(value || "").trim())
    .find((value) => value.includes("@") && !value.endsWith("@lid"));

  return preferred || fallbackJid;
}

function formatJidForDisplay(jid = "") {
  if (!jid) {
    return "Conversa";
  }

  if (jid.endsWith("@g.us")) {
    return `Grupo ${jid.slice(0, 12)}`;
  }

  if (jid.endsWith("@newsletter")) {
    return `Canal ${jid.slice(0, 12)}`;
  }

  const digits = jid.replace(/\D/g, "");
  if (!digits) {
    return jid;
  }

  if (digits.length >= 12) {
    const ddi = digits.slice(0, 2);
    const ddd = digits.slice(2, 4);
    const prefix = digits.slice(4, digits.length - 4);
    const suffix = digits.slice(-4);
    return `+${ddi} (${ddd}) ${prefix}-${suffix}`;
  }

  return digits;
}

async function resolveWaMeLink(link) {
  return new Promise((resolve) => {
    https.get(link, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => {
            const match = data.match(/phone=([0-9]+)/);
            resolve(match ? match[1] + '@s.whatsapp.net' : null);
          });
        }).on('error', () => resolve(null));
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const match = data.match(/phone=([0-9]+)/);
          resolve(match ? match[1] + '@s.whatsapp.net' : null);
        });
      }
    }).on('error', () => resolve(null));
  });
}

async function extractJidFromLink(urlStr) {
  if (!urlStr) return null;
  const cleanUrl = urlStr.trim();
  
  // 1. Check if it's a short link that requires resolving: /message/XXXXXX
  const waMeShortMatch = cleanUrl.match(/https?:\/\/(?:wa\.me|api\.whatsapp\.com)\/message\/([a-zA-Z0-9]+)/i);
  if (waMeShortMatch) {
    const resolved = await resolveWaMeLink(cleanUrl);
    if (resolved) {
      return normalizeJidInput(resolved);
    }
  }

  // 2. Check if it's a standard wa.me/number link, e.g. wa.me/5511999999999
  const phoneUrlMatch = cleanUrl.match(/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\/(?:send\/?\?phone=)?(\+?[0-9\-\s\(\)]+)/i);
  if (phoneUrlMatch) {
    return normalizeJidInput(phoneUrlMatch[1]);
  }

  const simpleMatch = cleanUrl.match(/(?:wa\.me)\/(\+?[0-9\-\s\(\)]+)/i);
  if (simpleMatch) {
    return normalizeJidInput(simpleMatch[1]);
  }

  return null;
}


function normalizeJidInput(value) {
  let valStr = String(value).trim();
  
  let domain = "@s.whatsapp.net";
  let numberPart = valStr;
  
  if (valStr.includes("@")) {
    const parts = valStr.split("@");
    numberPart = parts[0];
    domain = "@" + parts[1];
  } else {
    const phoneUrlMatch = valStr.match(/(?:wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\/(?:send\/?\?phone=)?([0-9]+)/i);
    if (phoneUrlMatch) {
      numberPart = phoneUrlMatch[1];
    } else {
      const simpleMatch = valStr.match(/(?:wa\.me)\/([0-9]+)/i);
      if (simpleMatch) {
        numberPart = simpleMatch[1];
      }
    }
  }

  const digits = numberPart.replace(/\D/g, "");
  if (!digits) {
    throw new Error("Numero invalido.");
  }

  if (domain !== "@s.whatsapp.net" && domain !== "@c.us") {
    return `${digits}${domain}`;
  }

  let cleanNumber = digits;
  if (cleanNumber.length === 10 || cleanNumber.length === 11) {
    const ddd = parseInt(cleanNumber.slice(0, 2), 10);
    if (ddd >= 11 && ddd <= 99) {
      cleanNumber = "55" + cleanNumber;
    }
  }

  return `${cleanNumber}@s.whatsapp.net`;
}

function normalizeOutboundMediaInput(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Arquivo invalido.");
  }

  const mimeType = String(input.mimeType || "").trim().toLowerCase();
  const fileName = String(input.fileName || "").trim() || null;
  const data = extractBase64Payload(input.data || "");
  const requestedKind = String(input.kind || "auto").trim().toLowerCase();
  const kind = inferOutboundMediaKind(requestedKind, mimeType, fileName);

  if (!data) {
    throw new Error("Arquivo em base64 nao informado.");
  }

  if (kind === "sticker" && mimeType && mimeType !== "image/webp") {
    throw new Error("Para enviar sticker, use um arquivo WEBP.");
  }

  return {
    kind,
    mimeType: mimeType || defaultMimeTypeForMediaKind(kind),
    fileName,
    data,
  };
}

function inferOutboundMediaKind(requestedKind, mimeType, fileName) {
  if (["image", "video", "audio", "document", "sticker"].includes(requestedKind)) {
    return requestedKind;
  }

  const extension = getFileExtension(fileName);
  if (mimeType.startsWith("image/")) {
    return "image";
  }

  if (mimeType.startsWith("video/")) {
    return "video";
  }

  if (mimeType.startsWith("audio/")) {
    return "audio";
  }

  if (mimeType) {
    return "document";
  }

  if (["jpg", "jpeg", "png", "gif", "webp"].includes(extension)) {
    return "image";
  }

  if (["mp4", "mov", "webm", "mkv"].includes(extension)) {
    return "video";
  }

  if (["mp3", "ogg", "wav", "m4a", "aac"].includes(extension)) {
    return "audio";
  }

  return "document";
}

function extractBase64Payload(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (raw.startsWith("data:")) {
    const delimiterIndex = raw.indexOf("base64,");
    if (delimiterIndex >= 0) {
      return raw.slice(delimiterIndex + 7);
    }
  }

  return raw;
}

function prepareOutgoingMediaPayload(payload) {
  const media = payload?.media;
  if (!media) {
    throw new Error("Arquivo nao informado.");
  }

  const buffer = Buffer.from(media.data, "base64");
  if (!buffer.length) {
    throw new Error("Arquivo vazio.");
  }

  const caption = payload.text || undefined;
  let content;

  switch (media.kind) {
    case "image":
      content = {
        image: buffer,
        mimetype: media.mimeType || "image/jpeg",
        caption,
      };
      break;
    case "video":
      content = {
        video: buffer,
        mimetype: media.mimeType || "video/mp4",
        caption,
      };
      break;
    case "audio":
      content = {
        audio: buffer,
        mimetype: media.mimeType || "audio/ogg",
        ptt: false,
      };
      break;
    case "document":
      content = {
        document: buffer,
        mimetype: media.mimeType || "application/octet-stream",
        fileName: media.fileName || `arquivo.${guessExtensionFromMimeType(media.mimeType)}`,
        caption,
      };
      break;
    case "sticker":
      content = {
        sticker: buffer,
      };
      break;
    default:
      throw new Error("Tipo de arquivo nao suportado.");
  }

  return {
    buffer,
    content,
  };
}

function buildOutgoingStoredMedia(media, cachedMedia) {
  if (!media) {
    return null;
  }

  return normalizeStoredMediaDescriptor({
    kind: media.kind,
    mimeType: media.mimeType,
    fileName: media.fileName || cachedMedia?.fileName || null,
    fileSize: null,
    width: null,
    height: null,
    seconds: null,
    isAnimated: false,
    cachePath: cachedMedia?.relativePath || null,
    download: null,
  });
}

function normalizeStoredMediaDescriptor(media) {
  if (!media || typeof media !== "object") {
    return null;
  }

  const kind = String(media.kind || "").trim() || "document";
  const download = media.download
    ? {
        mediaType: media.download.mediaType || kind,
        mimetype: media.download.mimetype || media.mimeType || defaultMimeTypeForMediaKind(kind),
        url: media.download.url || null,
        directPath: media.download.directPath || null,
        mediaKey: normalizeBase64Field(media.download.mediaKey),
        fileEncSha256: normalizeBase64Field(media.download.fileEncSha256),
        fileSha256: normalizeBase64Field(media.download.fileSha256),
        fileLength: Number(media.download.fileLength || 0) || null,
        fileName: media.download.fileName || media.fileName || null,
      }
    : null;

  return {
    kind,
    mimeType: media.mimeType || defaultMimeTypeForMediaKind(kind),
    fileName: media.fileName || null,
    fileSize: Number(media.fileSize || 0) || null,
    width: Number(media.width || 0) || null,
    height: Number(media.height || 0) || null,
    seconds: Number(media.seconds || 0) || null,
    isAnimated: Boolean(media.isAnimated),
    cachePath: typeof media.cachePath === "string" && media.cachePath ? media.cachePath : null,
    download,
  };
}

function normalizeStoredDownloadSource(kind, mediaMessage) {
  return {
    mediaType: kind,
    mimetype: mediaMessage.mimetype || defaultMimeTypeForMediaKind(kind),
    url: mediaMessage.url || null,
    directPath: mediaMessage.directPath || null,
    mediaKey: encodeBinaryField(mediaMessage.mediaKey),
    fileEncSha256: encodeBinaryField(mediaMessage.fileEncSha256),
    fileSha256: encodeBinaryField(mediaMessage.fileSha256),
    fileLength: Number(mediaMessage.fileLength || 0) || null,
    fileName: mediaMessage.fileName || null,
  };
}

function normalizeBase64Field(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encodeBinaryField(value) {
  if (!value) {
    return null;
  }

  return Buffer.from(value).toString("base64");
}

function decodeBinaryField(value) {
  if (!value) {
    return undefined;
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }

  return Buffer.from(value, "base64");
}

function buildMediaDownloadMessage(message) {
  const media = message?.media;
  const download = media?.download;
  if (!media || !download) {
    throw new Error("Mensagem sem dados de download.");
  }

  const type = mediaKindToContentType(media.kind);
  return {
    key: {
      remoteJid: message.jid,
      fromMe: Boolean(message.fromMe),
      id: message.id,
      participant: message.participant || undefined,
    },
    message: {
      [type]: {
        mimetype: download.mimetype || media.mimeType || defaultMimeTypeForMediaKind(media.kind),
        url: download.url || undefined,
        directPath: download.directPath || undefined,
        mediaKey: decodeBinaryField(download.mediaKey),
        fileEncSha256: decodeBinaryField(download.fileEncSha256),
        fileSha256: decodeBinaryField(download.fileSha256),
        fileLength: download.fileLength || undefined,
        fileName: download.fileName || media.fileName || undefined,
        seconds: media.seconds || undefined,
        width: media.width || undefined,
        height: media.height || undefined,
        isAnimated: media.isAnimated || undefined,
      },
    },
  };
}

function mediaKindToContentType(kind) {
  const mapping = {
    image: "imageMessage",
    video: "videoMessage",
    audio: "audioMessage",
    document: "documentMessage",
    sticker: "stickerMessage",
  };

  return mapping[kind] || "documentMessage";
}

function defaultMimeTypeForMediaKind(kind) {
  const mapping = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/ogg",
    document: "application/octet-stream",
    sticker: "image/webp",
  };

  return mapping[kind] || "application/octet-stream";
}

function getCachedMediaAbsolutePath(config, media) {
  if (!media?.cachePath) {
    return null;
  }

  return path.join(config.mediaDir, media.cachePath);
}

async function cacheMediaBuffer({ buffer, config, sessionId, messageId, media }) {
  const sessionMediaDir = path.join(config.mediaDir, sessionId);
  await fs.mkdir(sessionMediaDir, { recursive: true });

  const extension = getPreferredMediaExtension(media);
  const fileName = `${sanitizePathSegment(messageId)}.${extension}`;
  const filePath = path.join(sessionMediaDir, fileName);
  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    filePath,
    relativePath: path.join(sessionId, fileName).split(path.sep).join("/"),
  };
}

function getPreferredMediaExtension(media) {
  const fileNameExtension = getFileExtension(media?.fileName);
  if (fileNameExtension) {
    return fileNameExtension;
  }

  const mimeExtension = guessExtensionFromMimeType(media?.mimeType);
  if (mimeExtension) {
    return mimeExtension;
  }

  if (media?.download) {
    try {
      const downloadMessage = buildMediaDownloadMessage({
        ...media,
        id: "temp",
        jid: "temp@s.whatsapp.net",
        fromMe: false,
        participant: null,
        media,
      });
      return extensionForMediaMessage(downloadMessage.message) || "bin";
    } catch {}
  }

  return "bin";
}

function getFileExtension(fileName) {
  const extension = path.extname(String(fileName || "")).replace(/^\./, "").trim().toLowerCase();
  return extension || "";
}

function guessExtensionFromMimeType(mimeType) {
  const value = String(mimeType || "").trim().toLowerCase();
  const mapping = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "application/pdf": "pdf",
  };

  return mapping[value] || "";
}

function sanitizePathSegment(value) {
  return String(value || "arquivo")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "arquivo";
}

function serializeMe(value) {
  if (!value) {
    return null;
  }

  return {
    id: value.id || "",
    name: value.name || value.verifiedName || "",
    lid: value.lid || "",
  };
}

function getAccountId(value) {
  if (!value?.id) {
    return "";
  }

  return String(value.id);
}

function normalizeMessagesStore(input, fallbackSessionId) {
  if (!input || typeof input !== "object" || !Array.isArray(input.messages)) {
    return { messages: [] };
  }

  return {
    messages: input.messages.map((message) => ({
      id: message.id || `legacy_${Date.now()}`,
      sessionId: message.sessionId || fallbackSessionId,
      jid: message.jid || "",
      fromMe: Boolean(message.fromMe),
      text: typeof message.text === "string" ? message.text : "",
      timestamp: normalizeTimestamp(message.timestamp),
      type: message.type || "text",
      status: message.status || "stored",
      pushName: message.pushName || null,
      participant: message.participant || null,
      media: normalizeStoredMediaDescriptor(message.media),
    })),
  };
}

function normalizeConversationsStore(input, fallbackSessionId) {
  const store = { sessions: {} };

  if (input?.sessions && typeof input.sessions === "object") {
    for (const [sessionId, sessionData] of Object.entries(input.sessions)) {
      const bucket = ensureConversationBucket(store, sessionId);
      for (const [jid, conversation] of Object.entries(sessionData?.conversations || {})) {
        bucket[jid] = normalizeConversationEntry(conversation, jid);
      }
    }

    return store;
  }

  if (input?.conversations && typeof input.conversations === "object") {
    const bucket = ensureConversationBucket(store, fallbackSessionId);
    for (const legacyConversation of Object.values(input.conversations)) {
      const jid = legacyConversation?.lastJid || legacyConversation?.jids?.[0];
      if (!jid) {
        continue;
      }

      bucket[jid] = normalizeConversationEntry(legacyConversation, jid);
    }
  }

  return store;
}

function normalizeConversationEntry(entry, jid) {
  return {
    jid,
    title: entry?.title || formatJidForDisplay(jid),
    kind: getConversationKind(jid),
    updatedAt: Number(entry?.updatedAt || Date.now()),
    unreadCount: Number(entry?.unreadCount || 0),
    preview: entry?.preview || "",
    lastMessageAt: Number(entry?.lastMessageAt || entry?.updatedAt || Date.now()),
    messageCount: Number(entry?.messageCount || 0),
  };
}

function normalizeSessionStore(input) {
  const store = { sessions: {} };

  if (!input || typeof input !== "object" || !input.sessions || typeof input.sessions !== "object") {
    return store;
  }

  for (const [sessionId, session] of Object.entries(input.sessions)) {
    store.sessions[sessionId] = {
      id: sessionId,
      name: session?.name || formatSessionName(sessionId),
      createdAt: Number(session?.createdAt || Date.now()),
      updatedAt: Number(session?.updatedAt || Date.now()),
      webhook: normalizeWebhookSettings(session?.webhook || {}),
    };
  }

  return store;
}

function normalizeContactsStore(input) {
  const store = { sessions: {} };

  if (!input || typeof input !== "object" || !input.sessions || typeof input.sessions !== "object") {
    return store;
  }

  for (const [sessionId, sessionData] of Object.entries(input.sessions)) {
    const records = sessionData?.records && typeof sessionData.records === "object"
      ? sessionData.records
      : sessionData?.contacts && typeof sessionData.contacts === "object"
        ? sessionData.contacts
        : {};

    for (const contact of Object.values(records)) {
      upsertContact(store, sessionId, contact);
    }
  }

  return store;
}

function ensureContactBucket(store, sessionId) {
  if (!store.sessions) {
    store.sessions = {};
  }

  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = {
      records: {},
      aliases: {},
    };
  }

  if (!store.sessions[sessionId].records) {
    store.sessions[sessionId].records = {};
  }

  if (!store.sessions[sessionId].aliases) {
    store.sessions[sessionId].aliases = {};
  }

  return store.sessions[sessionId];
}

function normalizeContactEntry(entry) {
  const id = String(entry?.id || entry?.lid || entry?.jid || "").trim();

  return {
    id,
    lid: String(entry?.lid || "").trim() || null,
    jid: String(entry?.jid || "").trim() || null,
    name: String(entry?.name || "").trim() || null,
    notify: String(entry?.notify || "").trim() || null,
    verifiedName: String(entry?.verifiedName || "").trim() || null,
    subject: String(entry?.subject || "").trim() || null,
    imgUrl:
      typeof entry?.imgUrl === "string"
        ? entry.imgUrl
        : entry?.imgUrl === null
          ? null
          : undefined,
    status: String(entry?.status || "").trim() || null,
    updatedAt: Number(entry?.updatedAt || Date.now()),
  };
}

function upsertContact(store, sessionId, contact) {
  const normalized = normalizeContactEntry(contact);
  if (!normalized.id) {
    return false;
  }

  const bucket = ensureContactBucket(store, sessionId);
  const recordId =
    bucket.aliases[normalized.id] ||
    bucket.aliases[normalized.lid || ""] ||
    bucket.aliases[normalized.jid || ""] ||
    normalized.id;
  const previous = bucket.records[recordId] || null;
  const draft = {
    ...(previous || { id: recordId, updatedAt: 0 }),
    ...Object.fromEntries(
      Object.entries(normalized).filter(([, value]) => value !== undefined && value !== null && value !== ""),
    ),
    id: recordId,
  };
  const changed =
    !previous ||
    JSON.stringify({ ...previous, updatedAt: 0 }) !== JSON.stringify({ ...draft, updatedAt: 0 });
  const next = {
    ...draft,
    id: recordId,
    updatedAt: changed ? Date.now() : Number(previous?.updatedAt || Date.now()),
  };

  bucket.records[recordId] = next;

  for (const alias of [recordId, next.id, next.lid, next.jid].filter(Boolean)) {
    bucket.aliases[alias] = recordId;
  }

  return changed;
}

function getContactByAddress(contactStore, sessionId, address) {
  const bucket = ensureContactBucket(contactStore, sessionId);
  const recordId = bucket.aliases[address] || null;
  return recordId ? bucket.records[recordId] || null : null;
}

function normalizeSettingsStore(input) {
  const webhook = input?.webhook && typeof input.webhook === "object" ? input.webhook : {};

  return {
    webhook: {
      ...getDefaultWebhookSettings(),
      ...normalizeWebhookSettings(webhook),
    },
  };
}

function mergeSettingsStore(currentSettings, input) {
  const payload = input && typeof input === "object" ? input : {};
  const webhookInput = payload.webhook && typeof payload.webhook === "object" ? payload.webhook : {};
  const settings = normalizeSettingsStore({
    ...currentSettings,
    webhook: {
      ...(currentSettings?.webhook || {}),
      ...webhookInput,
    },
  });

  settings.webhook.url = normalizeWebhookUrl(settings.webhook.url);

  if (settings.webhook.enabled && !settings.webhook.url) {
    throw new Error("Informe a URL do webhook para ativar a entrega.");
  }

  return settings;
}

function getDefaultWebhookSettings(webhookUrl = String(process.env.WEBHOOK_URL || "").trim()) {
  return normalizeWebhookSettings({
    enabled: parseBoolean(process.env.WEBHOOK_ENABLED, Boolean(webhookUrl)),
    url: webhookUrl,
    secret: String(process.env.WEBHOOK_SECRET || "").trim(),
    allowPrivate: parseBoolean(process.env.WEBHOOK_PRIVATE, true),
    allowGroups: parseBoolean(process.env.WEBHOOK_GROUPS, true),
    allowNewsletters: parseBoolean(process.env.WEBHOOK_NEWSLETTERS, false),
    allowBroadcasts: parseBoolean(process.env.WEBHOOK_BROADCASTS, false),
    includeFromMe: parseBoolean(process.env.WEBHOOK_FROM_ME, false),
  });
}

function normalizeWebhookSettings(input) {
  const webhook = input && typeof input === "object" ? input : {};

  return {
    enabled: parseBoolean(webhook.enabled, Boolean(String(webhook.url || "").trim())),
    url: String(webhook.url || "").trim(),
    secret: String(webhook.secret || "").trim(),
    allowPrivate: parseBoolean(webhook.allowPrivate, true),
    allowGroups: parseBoolean(webhook.allowGroups, true),
    allowNewsletters: parseBoolean(webhook.allowNewsletters, false),
    allowBroadcasts: parseBoolean(webhook.allowBroadcasts, false),
    includeFromMe: parseBoolean(webhook.includeFromMe, false),
  };
}

function cloneWebhookSettings(webhook) {
  return normalizeWebhookSettings(webhook);
}

function normalizeWebhookUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Informe uma URL de webhook valida.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Use uma URL http ou https para o webhook.");
  }

  return parsed.toString();
}

function getSessionWebhookSettings(sessionStore, sessionId) {
  const session = sessionStore.sessions?.[sessionId] || null;
  return cloneWebhookSettings(session?.webhook || getDefaultWebhookSettings());
}

function ensureSessionMeta(store, sessionId, patch = {}) {
  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = {
      id: sessionId,
      name: patch.name || formatSessionName(sessionId),
      createdAt: Number(patch.createdAt || Date.now()),
      updatedAt: Number(patch.updatedAt || Date.now()),
    };
  } else {
    store.sessions[sessionId] = {
      ...store.sessions[sessionId],
      ...patch,
      id: sessionId,
      name: patch.name || store.sessions[sessionId].name || formatSessionName(sessionId),
    };
  }

  return store.sessions[sessionId];
}

function listSessionIdsFromMessages(messagesStore) {
  return Array.from(
    new Set(
      messagesStore.messages
        .map((message) => message.sessionId || DEFAULT_SESSION_ID)
        .filter(Boolean),
    ),
  );
}

function listSessionIdsFromConversationStore(conversationsStore) {
  return Object.keys(conversationsStore.sessions || {});
}

function listSessionIdsFromContactStore(contactStore) {
  return Object.keys(contactStore.sessions || {});
}

async function listSessionDirectories(baseDir) {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("instagram_puppeteer_"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function hasSessionAuthFiles(sessionDir) {
  try {
    const entries = await fs.readdir(sessionDir);
    return entries.some((entry) => entry !== ".DS_Store");
  } catch {
    return false;
  }
}

async function migrateLegacyAuthFiles(baseDir, preferredSessionId) {
  const legacyNames = [
    "creds.json",
  ];

  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const legacyFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      legacyNames.includes(name) ||
      name.startsWith("app-state-sync-key-") ||
      name.startsWith("pre-key-") ||
      name.startsWith("session-") ||
      name.startsWith("sender-key-"),
    );

  if (!legacyFiles.length) {
    return null;
  }

  const targetDir = path.join(baseDir, preferredSessionId);
  await fs.mkdir(targetDir, { recursive: true });

  for (const fileName of legacyFiles) {
    await fs.rename(path.join(baseDir, fileName), path.join(targetDir, fileName));
  }

  return preferredSessionId;
}

function formatSessionName(sessionId) {
  const pretty = String(sessionId)
    .replace(/[-_]+/g, " ")
    .trim();

  if (!pretty) {
    return "Sessao";
  }

  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

function generateSessionId(name, sessionStore) {
  const base = slugify(name) || "sessao";
  let candidate = base;
  let index = 2;

  while (sessionStore.sessions[candidate]) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureDirectories(pathsToEnsure) {
  await Promise.all(pathsToEnsure.map((target) => fs.mkdir(target, { recursive: true })));
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) {
    return fallback;
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createJsonWriter(filePath, logger) {
  let queue = Promise.resolve();

  return async (payload) => {
    queue = queue
      .catch(() => undefined)
      .then(() => fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"))
      .catch((error) => {
        logger.error({ error, filePath }, "Falha ao persistir arquivo JSON.");
        throw error;
      });

    return queue;
  };
}

function getPathname(rawUrl = "/") {
  return rawUrl.split("?")[0] || "/";
}

function errorToMessage(error) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || String(error);
}
