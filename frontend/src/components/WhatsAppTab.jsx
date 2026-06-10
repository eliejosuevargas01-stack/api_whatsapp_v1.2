import React, { useState, useEffect, useRef } from 'react';
import { Search, Send, Paperclip, X, MessageSquare, Radio, HelpCircle, FileText, Image as ImageIcon, Check, CheckCheck, RefreshCw } from 'lucide-react';
import { apiRequest, formatDateTime, buildMediaUrl, fileToDataUrl, formatStatus } from '../shared/api';

export default function WhatsAppTab({ sessions, selectedSessionId, setSelectedSessionId }) {
  const [activeSubTab, setActiveSubTab] = useState('chats'); // 'chats' or 'status'
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState([]);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  
  // Active conversation state
  const [selectedJid, setSelectedJid] = useState('');
  const [conversationDetail, setConversationDetail] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [remoteHistoryExhausted, setRemoteHistoryExhausted] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  
  // Composer state
  const [text, setText] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [mediaKind, setMediaKind] = useState('auto');
  const [isSending, setIsSending] = useState(false);
  
  const [notice, setNotice] = useState('');
  
  const messageListRef = useRef(null);
  const fileInputRef = useRef(null);
  const autoRefreshTimerRef = useRef(null);

  // Filter WhatsApp-only sessions
  const whatsappSessions = sessions.filter(s => s.platform !== 'instagram');
  const selectedSession = whatsappSessions.find(s => s.id === selectedSessionId) || null;

  // Sync session changes
  useEffect(() => {
    // If no session selected, select the first WhatsApp session if available
    if (!selectedSessionId && whatsappSessions.length > 0) {
      setSelectedSessionId(whatsappSessions[0].id);
    }
  }, [whatsappSessions, selectedSessionId, setSelectedSessionId]);

  // Load conversations on session or sub-tab change
  useEffect(() => {
    setSelectedJid('');
    setMessages([]);
    setConversationDetail(null);
    setNotice('');
    if (selectedSessionId) {
      loadConversations(true);
    }
  }, [selectedSessionId, activeSubTab]);

  // Polling for new messages/conversations updates
  useEffect(() => {
    if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);

    autoRefreshTimerRef.current = setInterval(() => {
      if (selectedSessionId) {
        loadConversations(false);
      }
    }, 8000);

    return () => {
      if (autoRefreshTimerRef.current) clearInterval(autoRefreshTimerRef.current);
    };
  }, [selectedSessionId, selectedJid, search]);

  const loadConversations = async (showLoadingIndicator = false) => {
    if (!selectedSessionId) return;
    if (showLoadingIndicator) setIsLoadingConversations(true);

    const params = new URLSearchParams();
    params.set('limit', '300');
    if (search.trim()) {
      params.set('search', search.trim());
    }

    const pathSuffix = activeSubTab === 'status' ? 'status' : 'conversations';
    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/${pathSuffix}?${params.toString()}`);
    
    setIsLoadingConversations(false);

    if (response.ok) {
      const list = response.data.conversations || [];
      setConversations(list);
      
      // Update selected conversation in list if active
      if (selectedJid) {
        const activeItem = list.find(c => c.jid === selectedJid);
        if (!activeItem) {
          // If no longer exists in search, unselect
          setSelectedJid('');
          setConversationDetail(null);
          setMessages([]);
        } else {
          // Poll new messages silently
          fetchMessages(selectedJid, { silent: true, preserveScroll: true, markRead: true });
        }
      }
    } else {
      setNotice(response.error || 'Falha ao sincronizar conversas.');
    }
  };

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    // Debounced load
    const timeout = setTimeout(() => {
      loadConversations(true);
    }, 300);
    return () => clearTimeout(timeout);
  };

  const fetchMessages = async (jid, options = {}) => {
    if (!selectedSessionId || !jid) return;

    if (!options.silent) {
      setIsLoadingMessages(true);
    }

    const params = new URLSearchParams();
    params.set('limit', options.limit || '100');
    if (options.beforeId) {
      params.set('beforeId', options.beforeId);
    }

    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/conversations/${encodeURIComponent(jid)}/messages?${params.toString()}`);
    
    if (!options.silent) {
      setIsLoadingMessages(false);
    }

    if (response.ok) {
      const incoming = response.data.messages || [];
      const convo = response.data.conversation || null;
      const page = response.data.page || {};

      setConversationDetail(convo);
      setHasOlderMessages(!!page.hasOlder);

      setMessages(prev => {
        if (options.prepend) {
          const merged = [...incoming, ...prev];
          const unique = new Map();
          merged.forEach(m => unique.set(m.id, m));
          return [...unique.values()].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
        } else {
          return incoming;
        }
      });

      if (options.stickToBottom) {
        scrollToBottom();
      }

      if (options.markRead) {
        // Post read receipt
        await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/conversations/${encodeURIComponent(jid)}/read`, {
          method: 'POST'
        });
      }
    }
  };

  const selectConversation = async (jid) => {
    setSelectedJid(jid);
    setMessages([]);
    setRemoteHistoryExhausted(false);
    await fetchMessages(jid, { stickToBottom: true, markRead: true });
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      if (messageListRef.current) {
        messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
      }
    }, 100);
  };

  const handleScroll = async () => {
    if (!messageListRef.current || isLoadingOlder || (!hasOlderMessages && remoteHistoryExhausted)) return;
    
    // Check if scrolled close to top
    if (messageListRef.current.scrollTop <= 30 && messages.length > 0) {
      setIsLoadingOlder(true);
      const oldestId = messages[0]?.id;
      const preScrollHeight = messageListRef.current.scrollHeight;
      
      let loaded = 0;
      if (hasOlderMessages && oldestId) {
        // Fetch locally cached older messages
        await fetchMessages(selectedJid, {
          beforeId: oldestId,
          prepend: true,
          silent: true
        });
        loaded = 1;
      }

      // If no cached local messages, fetch from remote server history (Baileys fetch)
      if (!loaded && !remoteHistoryExhausted) {
        setNotice('Sincronizando histórico do celular...');
        const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/conversations/${encodeURIComponent(selectedJid)}/history`, {
          method: 'POST',
          body: JSON.stringify({ count: 50 })
        });

        if (response.ok) {
          if (response.data.requiresBootstrap) {
            setRemoteHistoryExhausted(true);
            setNotice('Histórico inicial pendente. Reconecte a sessão se necessário.');
          } else if (response.data.importedCount === 0) {
            setRemoteHistoryExhausted(true);
          } else {
            await fetchMessages(selectedJid, {
              beforeId: oldestId,
              prepend: true,
              silent: true
            });
            setNotice('Mensagens sincronizadas do celular.');
          }
        } else {
          setRemoteHistoryExhausted(true);
          setNotice(response.error || 'Erro ao carregar histórico.');
        }
      }

      setIsLoadingOlder(false);

      // Preserve scroll position after prepending
      setTimeout(() => {
        if (messageListRef.current) {
          const delta = messageListRef.current.scrollHeight - preScrollHeight;
          messageListRef.current.scrollTop = delta;
        }
      }, 50);
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!selectedSessionId || !selectedJid) return;
    if (!text.trim() && !selectedFile) return;

    setIsSending(true);
    setNotice('Enviando...');

    try {
      let media = null;
      if (selectedFile) {
        media = {
          kind: mediaKind,
          mimeType: selectedFile.type || '',
          fileName: selectedFile.name || '',
          data: await fileToDataUrl(selectedFile)
        };
      }

      const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages/send`, {
        method: 'POST',
        body: JSON.stringify({
          jid: selectedJid,
          text: text.trim(),
          media
        })
      });

      setIsSending(false);

      if (response.ok) {
        setText('');
        setSelectedFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        setNotice('Mensagem enviada.');
        await fetchMessages(selectedJid, { stickToBottom: true, silent: true });
        loadConversations(false);
      } else {
        setNotice(response.error || 'Erro ao enviar a mensagem.');
      }
    } catch (err) {
      setIsSending(false);
      setNotice(err.message || 'Erro no envio.');
    }
  };

  const renderMedia = (msg) => {
    if (!msg.media) return null;
    const mediaUrl = buildMediaUrl(selectedSessionId, msg.id);

    if (msg.media.kind === 'image' || msg.media.kind === 'sticker') {
      return (
        <div className="media-preview-box">
          <img src={mediaUrl} alt={msg.media.fileName || 'Imagem'} className="media-image" loading="lazy" />
        </div>
      );
    }

    if (msg.media.kind === 'video') {
      return (
        <div className="media-preview-box">
          <video src={mediaUrl} controls className="media-video" preload="metadata" />
        </div>
      );
    }

    if (msg.media.kind === 'audio') {
      return (
        <div className="media-preview-box audio-player">
          <audio src={mediaUrl} controls className="media-audio" preload="metadata" />
        </div>
      );
    }

    return (
      <div className="media-preview-box document-box">
        <FileText size={24} className="doc-icon" />
        <a href={mediaUrl} target="_blank" rel="noreferrer" download={msg.media.fileName || 'Arquivo'}>
          <span className="doc-name">{msg.media.fileName || 'Baixar Arquivo'}</span>
          <span className="doc-size">{msg.media.mimeType || 'Documento'}</span>
        </a>
      </div>
    );
  };

  return (
    <div className="tab-container chat-tab">
      <div className="tab-sidebar">
        <div className="sidebar-header">
          <select 
            className="input-field" 
            value={selectedSessionId}
            onChange={(e) => setSelectedSessionId(e.target.value)}
          >
            {whatsappSessions.length === 0 ? (
              <option value="">Nenhuma sessão do WhatsApp</option>
            ) : (
              whatsappSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} • {formatStatus(session.snapshot?.status)}
                </option>
              ))
            )}
          </select>
        </div>

        <div className="chat-sub-tabs">
          <button 
            className={`sub-tab-btn ${activeSubTab === 'chats' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('chats')}
          >
            <MessageSquare size={16} /> Conversas
          </button>
          <button 
            className={`sub-tab-btn ${activeSubTab === 'status' ? 'active' : ''}`}
            onClick={() => setActiveSubTab('status')}
          >
            <Radio size={16} /> Status & Canais
          </button>
        </div>

        <div className="search-bar">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            className="input-field search-input"
            placeholder="Pesquisar conversas..."
            value={search}
            onChange={handleSearchChange}
          />
        </div>

        <div className="conversations-list scrollable">
          {isLoadingConversations ? (
            <div className="empty-message shimmer-card">Sincronizando...</div>
          ) : conversations.length === 0 ? (
            <div className="empty-message">Nenhuma conversa encontrada.</div>
          ) : (
            conversations.map((convo) => (
              <div
                key={convo.jid}
                className={`conversation-list-item ${selectedJid === convo.jid ? 'active' : ''}`}
                onClick={() => selectConversation(convo.jid)}
              >
                <div className="convo-avatar">
                  {convo.imgUrl ? (
                    <img 
                      src={convo.imgUrl} 
                      alt="Avatar" 
                      style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} 
                    />
                  ) : (
                    <MessageSquare size={20} />
                  )}
                </div>
                <div className="convo-info">
                  <div className="convo-name-row">
                    <span className="convo-name">{convo.title || convo.jid.split('@')[0]}</span>
                    <span className="convo-time">{formatDateTime(convo.lastMessageTimestamp)}</span>
                  </div>
                  <div className="convo-preview-row">
                    <span className="convo-preview text-truncate">{convo.preview || 'Sem mensagens.'}</span>
                    {convo.unreadCount > 0 && (
                      <span className="unread-badge">{convo.unreadCount}</span>
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="tab-main-panel chat-window">
        {selectedJid ? (
          <>
            <div className="chat-window-header glass-panel">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {conversationDetail?.imgUrl ? (
                  <img 
                    src={conversationDetail.imgUrl} 
                    alt="Avatar" 
                    style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} 
                  />
                ) : (
                  <div className="convo-avatar" style={{ width: '40px', height: '40px' }}>
                    <MessageSquare size={18} />
                  </div>
                )}
                <div className="header-info">
                  <h3 style={{ margin: 0 }}>{conversationDetail?.title || selectedJid.split('@')[0]}</h3>
                  <span className="sub">{selectedJid}</span>
                </div>
              </div>
              {notice && <div className="header-notice-pill">{notice}</div>}
            </div>

            <div 
              className="chat-messages scrollable" 
              ref={messageListRef}
              onScroll={handleScroll}
            >
              {isLoadingOlder && <div className="loader-centered"><RefreshCw size={16} className="spinner" /> Sincronizando histórico...</div>}
              
              {messages.length === 0 ? (
                <div className="empty-chat-message">Inicie a conversa enviando uma mensagem abaixo.</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={`message-bubble-wrapper ${msg.fromMe ? 'outbound' : 'inbound'}`}>
                    <div className="message-bubble">
                      {renderMedia(msg)}
                      {msg.text && <p className="message-text">{msg.text}</p>}
                      <div className="message-timestamp">
                        {new Date(Number(msg.timestamp) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {msg.fromMe && (
                          <span className="status-ticks">
                            {msg.status === 'read' ? <CheckCheck size={12} className="ticks-read" /> : <Check size={12} />}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={handleSendMessage} className="chat-composer-form glass-panel">
              {selectedFile && (
                <div className="composer-file-chip">
                  <FileText size={14} />
                  <span className="file-name text-truncate">{selectedFile.name}</span>
                  <select 
                    className="input-field file-kind-select" 
                    value={mediaKind}
                    onChange={(e) => setMediaKind(e.target.value)}
                  >
                    <option value="auto">Auto</option>
                    <option value="image">Imagem</option>
                    <option value="video">Vídeo</option>
                    <option value="audio">Áudio</option>
                    <option value="document">Documento</option>
                  </select>
                  <button type="button" onClick={() => setSelectedFile(null)} className="clear-file-btn">
                    <X size={14} />
                  </button>
                </div>
              )}

              <div className="composer-controls">
                <button 
                  type="button" 
                  className="icon-btn" 
                  onClick={() => fileInputRef.current?.click()}
                  title="Anexar arquivo"
                >
                  <Paperclip size={20} />
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
                
                <input
                  type="text"
                  className="input-field composer-input"
                  placeholder="Digite sua mensagem..."
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />

                <button type="submit" className="btn btn-primary send-btn" disabled={isSending}>
                  <Send size={16} />
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="empty-state-panel">
            <MessageSquare size={64} className="empty-icon" />
            <h2>Conversa não Selecionada</h2>
            <p>Selecione uma conversa ativa na lista lateral para visualizar as mensagens.</p>
          </div>
        )}
      </div>
    </div>
  );
}
