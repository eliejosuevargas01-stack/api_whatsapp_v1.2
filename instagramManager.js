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
  const identity = String(username || "").trim().toLowerCase();

  if (!identity) {
    throw new Error('Informe um usuario ou email valido para o Instagram.');
  }

  // O session ID sera o proprio username normalizado.
  const sessionId = identity;

  if (instagramClients.has(sessionId)) {
    return { sessionId, message: 'Sessao ja existente.' };
  }

  ig.state.generateDevice(identity);

  // Evitar simular o dispositivo no PC local.
  // Vamos usar simulate pre ou post login
  await ig.simulate.preLoginFlow();

  try {
    const auth = await ig.account.login(identity, password);
    console.log(`[${sessionId}] Login successful. Checkpoint state:`, ig.state.checkpoint ? 'PENDENTE' : 'NENHUM');
    
    // Executar postLoginFlow em background sem bloquear a resposta
    process.nextTick(async () => {
      try {
        await ig.simulate.postLoginFlow();
      } catch (err) {
        console.warn(`postLoginFlow falhou para [${sessionId}], mas continuando:`, err?.message);
      }
    });

    instagramClients.set(sessionId, ig);

    // Verificar se há checkpoint pendente
    if (ig.state.checkpoint) {
      console.log(`[${sessionId}] Checkpoint detectado, buscando desafio...`);
      await ig.challenge.state();
      const challenge = buildInstagramChallengePayload(ig);
      instagramChallenges.set(sessionId, challenge);
      return { challenge, sessionId };
    }

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

    const message = String(error?.message || 'Erro desconhecido no login do Instagram.');
    if (message.includes("We can't find an account") || message.includes('não foi encontrado')) {
      throw new Error('Conta nao encontrada. Verifique se o usuario/telefone esta correto e tente novamente.');
    }

    throw new Error(`Falha no login do Instagram: ${message}`);
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
      if (e instanceof IgCheckpointError) {
        console.warn(`Instagram checkpoint requerido durante polling [${sessionId}]:`, e.message);
        clearInterval(interval);
        instagramIntervals.delete(sessionId);
        return;
      }
      // Capturar qualquer outro erro sem derrubar o servidor
      console.warn(`Erro no polling do Instagram [${sessionId}] - continuando: ${e?.message || e}`);
      // Não limpar o interval aqui, apenas registrar o erro
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
