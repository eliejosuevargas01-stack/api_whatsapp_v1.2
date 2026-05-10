export const storageKey = "api-whatsapp-panel";

export function loadPanelState() {
  try {
    return JSON.parse(localStorage.getItem(storageKey) || "{}");
  } catch {
    return {};
  }
}

export function savePanelState(partialState) {
  const previous = loadPanelState();
  localStorage.setItem(storageKey, JSON.stringify({ ...previous, ...partialState }));
}

export async function apiRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  try {
    const response = await fetch(path, {
      ...options,
      headers,
    });

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};

    return {
      ok: response.ok,
      status: response.status,
      data,
      error: data?.message || data?.error || "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error?.message || "Falha de rede.",
    };
  }
}

export function formatStatus(status) {
  const labels = {
    idle: "inativa",
    connecting: "conectando",
    qr: "aguardando QR",
    connected: "conectada",
    disconnected: "fechada",
    logged_out: "resetada",
  };

  return labels[status] || status || "inativa";
}

export function formatDateTime(timestamp) {
  if (!timestamp) {
    return "sem data";
  }

  const value = Number(timestamp) < 1_000_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp);
  return new Date(value).toLocaleString("pt-BR");
}

export function buildMediaUrl(sessionId, messageId) {
  return `/api/sessions/${encodeURIComponent(sessionId)}/media?messageId=${encodeURIComponent(messageId)}`;
}

export function debounce(callback, wait = 250) {
  let timeout = null;

  return (...args) => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(() => {
      callback(...args);
    }, wait);
  };
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export function getSessionById(sessions, sessionId) {
  return sessions.find((session) => session.id === sessionId) || null;
}
