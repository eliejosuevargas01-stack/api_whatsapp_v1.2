import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, AlertCircle, RefreshCw, ArrowLeft, Key, UserCheck, X, Copy, ExternalLink } from 'lucide-react';

const Instagram = ({ size = 24, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
    <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
  </svg>
);

import { apiRequest, formatDateTime } from '../shared/api';

export default function InstagramTab({ sessions, onRefreshSessions, selectedSessionId, setSelectedSessionId }) {
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  
  // Chat view state
  const [selectedThreadId, setSelectedThreadId] = useState('');
  const [conversationDetail, setConversationDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [text, setText] = useState('');
  const [isSending, setIsSending] = useState(false);

  // Outbound lead sender state
  const [leadUsername, setLeadUsername] = useState('');
  const [leadText, setLeadText] = useState('');
  const [isSendingLead, setIsSendingLead] = useState(false);

  // Challenge Verification modal state
  const [showChallengeModal, setShowChallengeModal] = useState(false);
  const [challengeCode, setChallengeCode] = useState('');
  const [challengeUsername, setChallengeUsername] = useState('');
  const [isSubmittingChallenge, setIsSubmittingChallenge] = useState(false);
  const [challengeError, setChallengeError] = useState('');

  const [notice, setNotice] = useState('');
  const messageListRef = useRef(null);
  const autoRefreshTimerRef = useRef(null);

  // Filter Instagram accounts
  const instagramSessions = sessions.filter(s => s.platform === 'instagram');
  const selectedSession = instagramSessions.find(s => s.id === selectedSessionId) || null;

  // Sync selected session
  useEffect(() => {
    if (!selectedSessionId && instagramSessions.length > 0) {
      setSelectedSessionId(instagramSessions[0].id);
    }
  }, [instagramSessions, selectedSessionId, setSelectedSessionId]);

  // Load conversations when session changes
  useEffect(() => {
    setSelectedThreadId('');
    setMessages([]);
    setConversationDetail(null);
    setNotice('');
    if (selectedSessionId && selectedSession?.snapshot?.status === 'connected') {
      loadConversations(true);
    } else {
      setConversations([]);
    }
  }, [selectedSessionId]);

  // Auto-refresh conversations & messages
  useEffect(() => {
    if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);

    autoRefreshTimerRef.current = setInterval(() => {
      if (selectedSessionId && selectedSession?.snapshot?.status === 'connected') {
        loadConversations(false);
      }
    }, 10000);

    return () => {
      if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);
    };
  }, [selectedSessionId, selectedThreadId]);

  const loadConversations = async (showLoading = false) => {
    if (!selectedSessionId) return;
    if (showLoading) setIsLoadingConversations(true);

    const response = await apiRequest(`/api/instagram/sessions/${encodeURIComponent(selectedSessionId)}/conversations`);
    setIsLoadingConversations(false);

    if (response.ok) {
      setConversations(response.data.conversations || []);
      
      if (selectedThreadId) {
        fetchMessages(selectedThreadId, { silent: true });
      }
    } else {
      handleApiError(response, 'Falha ao sincronizar conversas.');
    }
  };

  const fetchMessages = async (threadId, options = {}) => {
    if (!selectedSessionId || !threadId) return;
    if (!options.silent) setIsLoadingMessages(true);

    const response = await apiRequest(`/api/instagram/sessions/${encodeURIComponent(selectedSessionId)}/conversations/${encodeURIComponent(threadId)}/messages`);
    
    if (!options.silent) setIsLoadingMessages(false);

    if (response.ok) {
      setMessages(response.data.messages || []);
      const convo = response.data.conversation || { title: 'Conversa Direct', jid: threadId };
      setConversationDetail(convo);
      if (options.stickToBottom) {
        scrollToBottom();
      }
    } else {
      handleApiError(response, 'Falha ao carregar histórico do Direct.');
    }
  };

  const handleApiError = (response, fallbackMsg) => {
    if (response.isCheckpoint) {
      setChallengeUsername(response.username || selectedSessionId);
      setShowChallengeModal(true);
      setNotice('Instagram requer verificação de segurança (Checkpoint).');
    } else {
      setNotice(response.error || fallbackMsg);
    }
  };

  const selectConversation = async (threadId) => {
    setSelectedThreadId(threadId);
    setMessages([]);
    await fetchMessages(threadId, { stickToBottom: true });
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      if (messageListRef.current) {
        messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
      }
    }, 100);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!selectedSessionId || !selectedThreadId || !text.trim()) return;

    setIsSending(true);
    setNotice('Enviando...');

    const response = await apiRequest(`/api/instagram/sessions/${encodeURIComponent(selectedSessionId)}/conversations/${encodeURIComponent(selectedThreadId)}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ text: text.trim() })
    });

    setIsSending(false);

    if (response.ok) {
      setText('');
      setNotice('Mensagem enviada.');
      await fetchMessages(selectedThreadId, { silent: true, stickToBottom: true });
      loadConversations(false);
    } else {
      handleApiError(response, 'Erro ao enviar mensagem.');
    }
  };

  const handleSendLeadMessage = async (e) => {
    e.preventDefault();
    if (!selectedSessionId) {
      setNotice('Selecione uma conta ativa do Instagram primeiro.');
      return;
    }
    const cleanUsername = leadUsername.trim().replace('@', '');
    const cleanText = leadText.trim();
    
    if (!cleanUsername || !cleanText) return;

    setIsSendingLead(true);
    setNotice(`Enviando mensagem para @${cleanUsername}...`);

    const response = await apiRequest('/api/instagram/send', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: selectedSessionId,
        usernameTo: cleanUsername,
        text: cleanText
      })
    });

    setIsSendingLead(false);

    if (response.ok) {
      setLeadUsername('');
      setLeadText('');
      setNotice(`Mensagem enviada com sucesso para @${cleanUsername}!`);
      setTimeout(() => {
        setNotice('');
        loadConversations(true);
      }, 3000);
    } else {
      handleApiError(response, 'Erro ao enviar direct para lead.');
    }
  };

  const handleManualSend = async () => {
    if (!text.trim() || !selectedThreadId) return;
    try {
      await navigator.clipboard.writeText(text.trim());
      window.open(`https://www.instagram.com/direct/t/${selectedThreadId}/`, '_blank');
      setNotice('Mensagem copiada para a área de transferência! Cole (Ctrl+V) no Instagram.');
      setTimeout(() => setNotice(''), 5000);
    } catch (err) {
      setNotice('Falha ao copiar texto.');
    }
  };

  const handleManualSendLead = async (e) => {
    e.preventDefault();
    const cleanUsername = leadUsername.trim().replace('@', '');
    const cleanText = leadText.trim();
    if (!cleanUsername || !cleanText) return;
    
    try {
      await navigator.clipboard.writeText(cleanText);
      window.open(`https://ig.me/m/${cleanUsername}`, '_blank');
      setNotice('Mensagem copiada para a área de transferência! Cole (Ctrl+V) no Instagram.');
      setTimeout(() => setNotice(''), 5000);
    } catch (err) {
      setNotice('Falha ao copiar texto.');
    }
  };

  const handleChallengeSubmit = async (e) => {
    e.preventDefault();
    const code = challengeCode.trim();
    if (!code || !challengeUsername) return;

    setIsSubmittingChallenge(true);
    setChallengeError('');

    const response = await apiRequest('/api/instagram/challenge', {
      method: 'POST',
      body: JSON.stringify({
        username: challengeUsername,
        code
      })
    });

    setIsSubmittingChallenge(false);

    if (response.ok) {
      setShowChallengeModal(false);
      setChallengeCode('');
      setChallengeError('');
      setNotice('Verificação de checkpoint bem-sucedida! Conta conectada.');
      onRefreshSessions();
    } else {
      setChallengeError(response.error || 'Código incorreto. Tente novamente.');
    }
  };

  const filteredConversations = conversations.filter(c => {
    if (!search.trim()) return true;
    return c.title.toLowerCase().includes(search.toLowerCase()) || c.jid.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="tab-container instagram-tab">
      <div className="tab-sidebar">
        <div className="sidebar-header">
          <select 
            className="input-field" 
            value={selectedSessionId}
            onChange={(e) => setSelectedSessionId(e.target.value)}
          >
            {instagramSessions.length === 0 ? (
              <option value="">Nenhuma conta do Instagram</option>
            ) : (
              instagramSessions.map((session) => {
                const nameMatch = String(session.name).match(/^[0-9a-f]{8}[-\s]+(.+)$/i);
                const displayName = nameMatch ? nameMatch[1] : session.name;
                return (
                  <option key={session.id} value={session.id}>
                    @{displayName} • {session.snapshot?.status === 'connected' ? 'Ativa' : 'Inativa'}
                  </option>
                );
              })
            )}
          </select>
        </div>

        {/* Action buttons list */}
        <div className="sidebar-actions-panel">
          <button 
            className={`sidebar-action-btn ${!selectedThreadId ? 'active' : ''}`}
            onClick={() => setSelectedThreadId('')}
          >
            <Instagram size={16} /> Envios de Leads
          </button>
        </div>

        {selectedSession?.snapshot?.status === 'connected' && (
          <>
            <div className="search-bar" style={{ marginTop: '12px' }}>
              <Search size={16} className="search-icon" />
              <input
                type="text"
                className="input-field search-input"
                placeholder="Pesquisar Directs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="conversations-list scrollable">
              {isLoadingConversations ? (
                <div className="empty-message shimmer-card">Sincronizando Directs...</div>
              ) : filteredConversations.length === 0 ? (
                <div className="empty-message">Nenhuma conversa encontrada.</div>
              ) : (
                filteredConversations.map((convo) => (
                  <div
                    key={convo.jid}
                    className={`conversation-list-item ${selectedThreadId === convo.jid ? 'active' : ''}`}
                    onClick={() => selectConversation(convo.jid)}
                  >
                    <div className="convo-avatar instagram-avatar">
                      <Instagram size={20} />
                    </div>
                    <div className="convo-info">
                      <div className="convo-name-row">
                        <span className="convo-name">{convo.title || convo.jid}</span>
                        <span className="convo-time">{formatDateTime(convo.lastMessageTimestamp)}</span>
                      </div>
                      <div className="convo-preview-row">
                        <span className="convo-preview text-truncate">{convo.preview || 'Mensagem direta.'}</span>
                        {convo.unreadCount > 0 && (
                          <span className="unread-badge">{convo.unreadCount}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="tab-main-panel chat-window">
        {selectedSession ? (
          <>
            {selectedThreadId ? (
              // Mode: Chat history
              <>
                <div className="chat-window-header glass-panel">
                  <div className="header-left-row">
                    <button onClick={() => setSelectedThreadId('')} className="icon-btn back-btn" title="Voltar para Lead Sender">
                      <ArrowLeft size={20} />
                    </button>
                    <div className="header-info">
                      <h3>{conversationDetail?.title || selectedThreadId}</h3>
                      <span className="sub">Direct ID: {selectedThreadId}</span>
                    </div>
                  </div>
                  {notice && <div className="header-notice-pill">{notice}</div>}
                </div>

                <div className="chat-messages scrollable" ref={messageListRef}>
                  {isLoadingMessages ? (
                    <div className="loader-centered"><RefreshCw size={16} className="spinner" /> Carregando mensagens do Direct...</div>
                  ) : messages.length === 0 ? (
                    <div className="empty-chat-message">Nenhuma mensagem nesta conversa.</div>
                  ) : (
                    messages.map((msg) => (
                      <div key={msg.id} className={`message-bubble-wrapper ${msg.fromMe ? 'outbound' : 'inbound'}`}>
                        <div className="message-bubble instagram-bubble">
                          <p className="message-text">{msg.text}</p>
                          <div className="message-timestamp">
                            {formatDateTime(msg.timestamp)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <form onSubmit={handleSendMessage} className="chat-composer-form glass-panel">
                  <div className="composer-controls">
                    <input
                      type="text"
                      className="input-field composer-input"
                      placeholder="Enviar direct..."
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                    />
                    <button 
                      type="button" 
                      onClick={handleManualSend} 
                      className="btn btn-secondary send-btn" 
                      title="Copiar e Abrir Manualmente"
                      style={{ marginRight: '6px', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                    >
                      <Copy size={16} />
                    </button>
                    <button type="submit" className="btn btn-instagram send-btn" disabled={isSending}>
                      <Send size={16} />
                    </button>
                  </div>
                </form>
              </>
            ) : (
              // Mode: Lead sender campaign form
              <div className="lead-sender-dashboard">
                <div className="dashboard-header glass-panel">
                  <h2>Envio de Mensagens a Leads</h2>
                  <p>Envie directs avulsos para novos prospects utilizando a infraestrutura do instagrapi.</p>
                  {notice && <div className="header-notice-pill" style={{ marginTop: '8px', display: 'inline-block' }}>{notice}</div>}
                </div>

                <div className="lead-form-container glass-panel">
                  {selectedSession.snapshot?.status === 'connected' ? (
                    <form onSubmit={handleSendLeadMessage}>
                      <div className="form-group">
                        <label className="form-label">Nome de Usuário (@lead)</label>
                        <input
                          type="text"
                          className="input-field"
                          placeholder="Ex: joaosilva ou @joaosilva"
                          value={leadUsername}
                          onChange={(e) => setLeadUsername(e.target.value)}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">Conteúdo da Mensagem</label>
                        <textarea
                          className="input-field textarea-field"
                          placeholder="Olá! Vi que você se interessa por desenvolvimento web..."
                          value={leadText}
                          onChange={(e) => setLeadText(e.target.value)}
                          rows={6}
                          required
                        />
                      </div>

                      <div style={{ display: 'flex', gap: '12px' }}>
                        <button type="submit" className="btn btn-instagram" disabled={isSendingLead} style={{ flex: 1 }}>
                          <Send size={16} />
                          {isSendingLead ? 'Enviando...' : 'Enviar Automático'}
                        </button>
                        <button 
                          type="button" 
                          onClick={handleManualSendLead} 
                          className="btn" 
                          style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)' }}
                        >
                          <ExternalLink size={16} />
                          Copiar e Abrir no Insta
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="inactive-session-alert">
                      <AlertCircle size={48} className="alert-icon" />
                      <h3>Sessão de @{(() => {
                        const nameMatch = String(selectedSession.name).match(/^[0-9a-f]{8}[-\s]+(.+)$/i);
                        return nameMatch ? nameMatch[1] : selectedSession.name;
                      })()} Inativa</h3>
                      <p>Para enviar DMs, a conta do Instagram precisa estar ativa. Por favor, reconecte-a na aba de Sessões.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="empty-state-panel">
            <Instagram size={64} className="empty-icon" />
            <h2>Nenhuma Conta do Instagram Selecionada</h2>
            <p>Selecione uma conta na barra lateral ou registre uma na aba de Sessões.</p>
          </div>
        )}
      </div>

      {/* Challenge / Checkpoint Modal */}
      {showChallengeModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3 className="modal-title">Desafio de Segurança</h3>
              <button onClick={() => setShowChallengeModal(false)} className="modal-close">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleChallengeSubmit}>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                O Instagram solicitou um código de verificação para a conta <strong>@{challengeUsername}</strong>. Digite o código enviado por SMS/E-mail.
              </p>
              
              <div className="form-group">
                <label className="form-label">Código de Verificação</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <Key size={18} style={{ alignSelf: 'center', color: 'var(--text-secondary)' }} />
                  <input
                    type="text"
                    className="input-field"
                    placeholder="Ex: 123456"
                    value={challengeCode}
                    onChange={(e) => setChallengeCode(e.target.value)}
                    required
                  />
                </div>
              </div>

              {challengeError && (
                <div style={{ color: 'var(--color-error)', fontSize: '0.75rem', marginBottom: '12px' }}>
                  {challengeError}
                </div>
              )}

              <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={isSubmittingChallenge}>
                {isSubmittingChallenge ? <RefreshCw size={16} className="spinner" /> : <UserCheck size={16} />}
                {isSubmittingChallenge ? 'Verificando...' : 'Confirmar Verificação'}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
