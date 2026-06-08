import { IgApiClient, IgCheckpointError, IgChallengeWrongCodeError } from 'instagram-private-api';
import EventEmitter from 'node:events';

export const igEmitter = new EventEmitter();

const instagramClients = new Map();
const instagramIntervals = new Map();
const instagramChallenges = new Map();

function buildInstagramChallengePayload(ig) {
  const challenge = ig.state.challenge || {};
  return {
    stepName: challenge.step_name,
    status: challenge.status,
    message: challenge.message || 'Instagram solicitou verificacao de seguranca.',
    stepData: challenge.step_data || {},
    challengeUrl: challenge.url,
    apiPath: challenge.api_path,
  };
}

export function getInstagramChallenge(sessionId) {
  const ig = instagramClients.get(sessionId);
  if (!ig) {
    throw new Error('Sessao do Instagram nao encontrada ou expirada.');
  }

  if (!ig.state.challenge) {
    throw new Error('Nenhum desafio pendente para esta sessao.');
  }

  return buildInstagramChallengePayload(ig);
}

export async function resolveInstagramChallenge(sessionId, { choice, code } = {}) {
  const ig = instagramClients.get(sessionId);
  if (!ig) {
    throw new Error('Sessao do Instagram nao encontrada ou expirada.');
  }

  if (!ig.state.challenge) {
    throw new Error('Nenhum desafio pendente para esta sessao.');
  }

  let response;
  if (choice !== undefined && choice !== null && choice !== '') {
    response = await ig.challenge.selectVerifyMethod(choice);
  } else if (code !== undefined && code !== null && code !== '') {
    try {
      response = await ig.challenge.sendSecurityCode(code);
    } catch (error) {
      if (error instanceof IgChallengeWrongCodeError) {
        throw new Error('Codigo incorreto. Tente novamente.');
      }
      throw error;
    }
  } else {
    response = await ig.challenge.auto();
  }

  if (response?.action === 'close' || ig.state.challenge === null) {
    const auth = await ig.account.currentUser();
    instagramChallenges.delete(sessionId);
    if (!instagramIntervals.has(sessionId)) {
      startPolling(sessionId, ig);
    }
    return { sessionId, user: auth };
  }

  const challenge = buildInstagramChallengePayload(ig);
  instagramChallenges.set(sessionId, challenge);
  return { challenge };
}

/**
 * Inicia uma sessao no Instagram.
 * Retorna o sessionId se sucesso.
 */
export async function loginInstagram(username, password) {
  const ig = new IgApiClient();

  // O session ID sera o proprio username neste exemplo
  const sessionId = username;

  if (instagramClients.has(sessionId)) {
    return { sessionId, message: 'Sessao ja existente.' };
  }

  ig.state.generateDevice(username);

  // Evitar simular o dispositivo no PC local.
  // Vamos usar simulate pre ou post login
  await ig.simulate.preLoginFlow();

  try {
    const auth = await ig.account.login(username, password);
    process.nextTick(async () => await ig.simulate.postLoginFlow());

    instagramClients.set(sessionId, ig);

    // Inicia o polling de mensagens
    startPolling(sessionId, ig);

    return { sessionId, user: auth };
  } catch (error) {
    if (error instanceof IgCheckpointError) {
      await ig.challenge.state();
      instagramClients.set(sessionId, ig);
      const challenge = buildInstagramChallengePayload(ig);
      instagramChallenges.set(sessionId, challenge);
      return { challenge, sessionId };
    }
    throw new Error(`Falha no login do Instagram: ${error.message}`);
  }
}

/**
 * Envia mensagem para um usuario
 */
export async function sendInstagramMessage(sessionId, usernameTo, text) {
  const ig = instagramClients.get(sessionId);
  if (!ig) {
    throw new Error('Sessao do Instagram nao encontrada.');
  }

  // Pegar o userId do destinatario
  const targetUser = await ig.user.searchExact(usernameTo);
  if (!targetUser || !targetUser.pk) {
    throw new Error('Usuario destinatario nao encontrado no Instagram.');
  }

  const thread = ig.entity.directThread([targetUser.pk.toString()]);
  await thread.broadcastText(text);

  return { success: true, to: usernameTo, text };
}

/**
 * Faz polling do Direct para verificar novas mensagens
 */
function startPolling(sessionId, ig) {
  // Limpar interval se ja houver
  if (instagramIntervals.has(sessionId)) {
    clearInterval(instagramIntervals.get(sessionId));
  }

  let lastSync = Date.now();

  const interval = setInterval(async () => {
    try {
      // Buscar inbox
      const inboxFeed = ig.feed.directInbox();
      const threads = await inboxFeed.items();

      const now = Date.now();

      for (const thread of threads) {
        for (const item of thread.items) {
          // O item.timestamp e em microsegundos
          const itemTime = Number(item.timestamp) / 1000;

          if (itemTime > lastSync && item.user_id !== ig.state.cookieUserId) {
            // Nova mensagem recebida!
            const messageObj = {
              sessionId,
              threadId: thread.thread_id,
              senderId: item.user_id,
              text: item.text || (item.item_type === 'link' ? item.link.text : item.item_type),
              timestamp: itemTime,
              id: item.item_id
            };

            igEmitter.emit('message', messageObj);
          }
        }
      }

      lastSync = now;
    } catch (e) {
      console.error(`Erro no polling do Instagram [${sessionId}]:`, e.message);
    }
  }, 10000); // 10 segundos de polling

  instagramIntervals.set(sessionId, interval);
}

export function logoutInstagram(sessionId) {
  if (instagramIntervals.has(sessionId)) {
    clearInterval(instagramIntervals.get(sessionId));
    instagramIntervals.delete(sessionId);
  }
  if (instagramClients.has(sessionId)) {
    instagramClients.delete(sessionId);
  }
}
