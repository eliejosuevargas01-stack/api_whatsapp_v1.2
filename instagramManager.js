import puppeteer from 'puppeteer';
import EventEmitter from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';

export const igEmitter = new EventEmitter();

const activeBrowsers = new Map(); // username -> browser instance
let sessionsDir = './sessions';

export function setInstagramSessionsDir(dir) {
  sessionsDir = dir;
}

/**
 * Auxiliar para instanciar/retornar o navegador com persistência de perfil do Chromium.
 */
async function getBrowser(username) {
  if (activeBrowsers.has(username)) {
    return activeBrowsers.get(username);
  }
  
  const userDir = path.resolve(path.join(sessionsDir, `instagram_puppeteer_${username}`));
  const browser = await puppeteer.launch({
    headless: true, // true para rodar em segundo plano no servidor
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--lang=en-US,en' // força inglês para seletores consistentes
    ],
    userDataDir: userDir
  });
  
  activeBrowsers.set(username, browser);
  return browser;
}

/**
 * Inicia uma sessão no Instagram usando Puppeteer.
 */
export async function loginInstagram(username, password) {
  const browser = await getBrowser(username);
  const page = await browser.newPage();
  
  try {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });
    
    // Se já estiver logado (redirecionado automaticamente para feed ou one-tap)
    if (page.url() === 'https://www.instagram.com/' || page.url().includes('/accounts/onetap/')) {
      await page.close();
      return { sessionId: username, message: 'Já logado.' };
    }
    
    // Digita as credenciais
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.type('input[name="username"]', username, { delay: 100 });
    await page.type('input[name="password"]', password, { delay: 100 });
    
    // Clica no botão de login
    await page.click('button[type="submit"]');
    
    // Aguarda o processamento
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    const url = page.url();
    if (url.includes('/challenge/') || url.includes('/verification/')) {
      // Checkpoint necessário
      await page.close();
      const error = new Error('O Instagram solicitou verificação (Checkpoint). Digite o código recebido.');
      error.isCheckpoint = true;
      throw error;
    }
    
    await page.close();
    return { sessionId: username };
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Resolve o desafio de checkpoint digitando o código recebido.
 */
export async function resolveInstagramChallenge(username, code) {
  const browser = await getBrowser(username);
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes('/challenge/'));
  
  if (!page) {
    page = await browser.newPage();
    await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
  }
  
  try {
    await page.waitForSelector('input[name="security_code"]', { timeout: 15000 });
    await page.type('input[name="security_code"]', code, { delay: 100 });
    
    await page.click('button[type="submit"]');
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    await page.close();
    return { success: true, message: 'Desafio resolvido e sessao iniciada.' };
  } catch (error) {
    await page.close();
    throw new Error(`Falha ao resolver o desafio: ${error.message}`);
  }
}

/**
 * Envia uma mensagem buscando o usuário diretamente (API legado).
 */
export async function sendInstagramMessage(sessionId, usernameTo, text) {
  const browser = await getBrowser(sessionId);
  const page = await browser.newPage();
  
  try {
    await page.goto(`https://www.instagram.com/${usernameTo}/`, { waitUntil: 'networkidle2' });
    
    if (page.url().includes('/accounts/login/')) {
      throw new Error('Sessão expirou ou não está logada.');
    }
    
    // Busca o botão de mensagem
    const messageBtnHandle = await page.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('button, div[role="button"], a'));
      return elements.find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt === 'message' || txt === 'enviar mensagem';
      });
    });
    
    if (!messageBtnHandle || !messageBtnHandle.asElement()) {
      throw new Error('Botão de mensagem não encontrado na página do usuário.');
    }
    
    await messageBtnHandle.asElement().click();
    
    const inputSelector = 'div[contenteditable="true"], textarea';
    await page.waitForSelector(inputSelector, { timeout: 20000 });
    
    await page.focus(inputSelector);
    await page.type(inputSelector, text, { delay: 100 });
    
    const sendClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const sendBtn = buttons.find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt === 'send' || txt === 'enviar';
      });
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      return false;
    });
    
    if (!sendClicked) {
      await page.keyboard.press('Enter');
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    await page.close();
    
    return { success: true, to: usernameTo, text };
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Retorna todas as contas cadastradas.
 */
export async function getInstagramSessionsList() {
  const active = Array.from(activeBrowsers.keys());
  try {
    await fs.mkdir(sessionsDir, { recursive: true });
    const files = await fs.readdir(sessionsDir);
    const igFolders = files.filter(f => f.startsWith('instagram_puppeteer_'));
    const all = igFolders.map(f => f.replace(/^instagram_puppeteer_/, ''));
    
    const uniqueUsernames = Array.from(new Set([...active, ...all]));
    return uniqueUsernames.map(username => ({
      id: username,
      name: username,
      active: active.includes(username)
    }));
  } catch (error) {
    return active.map(username => ({ id: username, name: username, active: true }));
  }
}

/**
 * Obtém conversas do direct inbox navegando visualmente e raspando os dados.
 */
export async function getInstagramConversations(sessionId) {
  const browser = await getBrowser(sessionId);
  const page = await browser.newPage();
  
  try {
    await page.goto('https://www.instagram.com/direct/inbox/', { waitUntil: 'networkidle2' });
    
    if (page.url().includes('/accounts/login/')) {
      throw new Error('Sessão expirou ou não está logada.');
    }
    
    // Busca a lista lateral de conversas
    const conversations = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="/direct/t/"]'));
      
      return anchors.map(anchor => {
        const href = anchor.getAttribute('href') || '';
        const threadId = href.split('/direct/t/')[1]?.split('/')[0] || '';
        
        const titleEl = anchor.querySelector('span');
        const title = titleEl ? titleEl.textContent : 'Conversa';
        
        const spans = Array.from(anchor.querySelectorAll('span'));
        let preview = '';
        if (spans.length > 1) {
          preview = spans[spans.length - 1].textContent || '';
        }
        
        // Verifica se há novas mensagens não lidas
        const unreadCount = anchor.innerHTML.includes('background-color: rgb(0, 149, 246)') || anchor.innerHTML.includes('background-color: rgb(0, 149, 246)') ? 1 : 0;
        
        return {
          jid: threadId,
          title,
          preview,
          unreadCount,
          lastMessageTimestamp: Date.now() / 1000
        };
      }).filter(c => c.jid);
    });
    
    await page.close();
    return conversations;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Carrega mensagens de uma conversa calculando os estilos das bolhas de texto.
 */
export async function getInstagramThreadMessages(sessionId, threadId) {
  const browser = await getBrowser(sessionId);
  const page = await browser.newPage();
  
  try {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'networkidle2' });
    
    const messages = await page.evaluate(() => {
      // Encontra a área com scroll de mensagens
      const scrollContainers = Array.from(document.querySelectorAll('div'));
      const chatContainer = scrollContainers.find(el => {
        const style = window.getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflowY === 'scroll';
      }) || document.body;
      
      // Filtra as bolhas que possuem cor de fundo e texto (elementos folhas)
      const divs = Array.from(chatContainer.querySelectorAll('div'));
      const messageBubbles = divs.filter(d => {
        const style = window.getComputedStyle(d);
        const hasBg = style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
        const hasText = d.textContent.trim().length > 0;
        const children = Array.from(d.children);
        const hasBgChild = children.some(c => {
          const cStyle = window.getComputedStyle(c);
          return cStyle.backgroundColor && cStyle.backgroundColor !== 'transparent' && cStyle.backgroundColor !== 'rgba(0, 0, 0, 0)';
        });
        return hasBg && hasText && !hasBgChild;
      });
      
      return messageBubbles.map((bubble, idx) => {
        // Checa alinhamento dos ancestrais para determinar se a mensagem foi enviada pelo próprio bot
        let parent = bubble.parentElement;
        let fromMe = false;
        while (parent && parent !== chatContainer) {
          const pStyle = window.getComputedStyle(parent);
          if (pStyle.justifyContent === 'flex-end' || pStyle.alignItems === 'flex-end' || pStyle.flexDirection === 'row-reverse') {
            fromMe = true;
            break;
          }
          parent = parent.parentElement;
        }
        
        return {
          id: `msg_${idx}`,
          fromMe,
          text: bubble.textContent.trim(),
          timestamp: Date.now() / 1000 - (messageBubbles.length - idx) * 10 // simula histórico temporal linear
        };
      });
    });
    
    await page.close();
    return messages;
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Envia uma mensagem direta para um thread ID específico usando o navegador Puppeteer.
 */
export async function sendInstagramThreadMessage(sessionId, threadId, text) {
  const browser = await getBrowser(sessionId);
  const page = await browser.newPage();
  
  try {
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, { waitUntil: 'networkidle2' });
    
    const inputSelector = 'div[contenteditable="true"], textarea';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    
    await page.focus(inputSelector);
    await page.type(inputSelector, text, { delay: 100 });
    
    const sendClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
      const sendBtn = buttons.find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt === 'send' || txt === 'enviar';
      });
      if (sendBtn) {
        sendBtn.click();
        return true;
      }
      return false;
    });
    
    if (!sendClicked) {
      await page.keyboard.press('Enter');
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    await page.close();
    return { success: true };
  } catch (error) {
    await page.close();
    throw error;
  }
}

/**
 * Fecha a instância do navegador e exclui os cookies da conta.
 */
export async function logoutInstagram(username) {
  if (activeBrowsers.has(username)) {
    const browser = activeBrowsers.get(username);
    try {
      await browser.close();
    } catch (err) {
      // ignorar
    }
    activeBrowsers.delete(username);
  }
  
  const userDir = path.resolve(path.join(sessionsDir, `instagram_puppeteer_${username}`));
  try {
    await fs.rm(userDir, { recursive: true, force: true });
    console.log(`[Instagram-Puppeteer] Sessao excluida do disco para ${username}`);
  } catch (error) {
    console.error(`[Instagram-Puppeteer] Erro ao excluir pasta de sessao:`, error.message);
  }
}

/**
 * Inicializa os navegadores em segundo plano para restaurar sessões salvas.
 */
export async function initInstagramSessions(dir) {
  if (dir) {
    sessionsDir = dir;
  }
  try {
    await fs.mkdir(sessionsDir, { recursive: true });
    const files = await fs.readdir(sessionsDir);
    const igFolders = files.filter(f => f.startsWith('instagram_puppeteer_'));
    
    console.log(`[Instagram-Puppeteer] Encontradas ${igFolders.length} sessoes para inicializar.`);
    for (const folder of igFolders) {
      const username = folder.replace(/^instagram_puppeteer_/, '');
      try {
        await getBrowser(username);
        console.log(`[Instagram-Puppeteer] Sessao carregada: ${username}`);
      } catch (err) {
        console.error(`[Instagram-Puppeteer] Falha ao pre-inicializar ${username}:`, err.message);
      }
    }
  } catch (error) {
    console.error(`[Instagram-Puppeteer] Erro ao inicializar sessoes:`, error.message);
  }
}
