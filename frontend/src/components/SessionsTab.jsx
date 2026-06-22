import React, { useState, useEffect, useRef } from 'react';
import { Plus, RefreshCw, Power, LogOut, Trash2, Save, Settings, Shield } from 'lucide-react';
import { apiRequest, formatStatus } from '../shared/api';

export function parseSessionInfo(sessionId, sessionName) {
  if (!sessionId) return { userHash: null, friendlyId: '', friendlyName: '', isNamespaced: false };
  const match = String(sessionId).match(/^([0-9a-f]{8})-(.+)$/i);
  if (match) {
    const userHash = match[1];
    const friendlyId = match[2];
    
    let friendlyName = sessionName || '';
    const nameMatch = String(sessionName).match(/^[0-9a-f]{8}[-\s]+(.+)$/i);
    if (nameMatch) {
      friendlyName = nameMatch[1];
    }
    return {
      userHash,
      friendlyId,
      friendlyName,
      isNamespaced: true
    };
  }
  return {
    userHash: null,
    friendlyId: sessionId,
    friendlyName: sessionName || '',
    isNamespaced: false
  };
}

export default function SessionsTab({ sessions, onRefreshSessions, selectedSessionId, setSelectedSessionId }) {
  const [platform, setPlatform] = useState('whatsapp');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionNote, setSessionNote] = useState('');
  
  // CRM Integration state
  const [recipient, setRecipient] = useState('');
  const [token, setToken] = useState('');
  const [crmRecipient, setCrmRecipient] = useState('');
  const [crmToken, setCrmToken] = useState('');
  const [isSavingCrmSettings, setIsSavingCrmSettings] = useState(false);
  const [crmNote, setCrmNote] = useState('');

  // Webhook settings state
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [allowPrivate, setAllowPrivate] = useState(true);
  const [allowGroups, setAllowGroups] = useState(true);
  const [allowNewsletters, setAllowNewsletters] = useState(false);
  const [allowBroadcasts, setAllowBroadcasts] = useState(false);
  const [includeFromMe, setIncludeFromMe] = useState(false);
  const [settingsNote, setSettingsNote] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // M2M API Credentials state
  const [m2mClientId, setM2mClientId] = useState('');
  const [m2mHasCredentials, setM2mHasCredentials] = useState(false);
  const [m2mPasswordInput, setM2mPasswordInput] = useState('');
  const [m2mSecretResponse, setM2mSecretResponse] = useState('');
  const [isGeneratingM2m, setIsGeneratingM2m] = useState(false);
  const [m2mNote, setM2mNote] = useState('');

  const getEmailFromToken = () => {
    const tokenStr = localStorage.getItem('whatsapp_session_token');
    if (!tokenStr) return '';
    try {
      const base64Url = tokenStr.split('.')[1];
      const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(jsonPayload).email || '';
    } catch (e) {
      return '';
    }
  };

  const loadM2mCredentials = async () => {
    const response = await apiRequest('/api/v1/clients/credentials');
    if (response.ok && response.data) {
      setM2mClientId(response.data.client_id || '');
      setM2mHasCredentials(!!response.data.hasCredentials);
    }
  };

  const handleGenerateM2m = async (e) => {
    e.preventDefault();
    if (!m2mPasswordInput) return;
    setIsGeneratingM2m(true);
    setM2mNote('Gerando credenciais M2M...');
    setM2mSecretResponse('');
    
    const email = getEmailFromToken();
    const response = await apiRequest('/api/v1/clients/reprovision', {
      method: 'POST',
      body: JSON.stringify({ email, password: m2mPasswordInput })
    });
    
    setIsGeneratingM2m(false);
    if (response.ok && response.data) {
      setM2mClientId(response.data.client_id);
      setM2mSecretResponse(response.data.client_secret);
      setM2mHasCredentials(true);
      setM2mPasswordInput('');
      setM2mNote('Novas credenciais M2M geradas com sucesso!');
    } else {
      setM2mNote(response.error || 'Falha ao gerar credenciais M2M. Verifique sua senha.');
    }
  };

  // Carrega credenciais M2M ao montar o componente
  useEffect(() => {
    loadM2mCredentials();
  }, []);

  const selectedSession = sessions.find(s => s.id === selectedSessionId) || null;

  // Load settings when session changes
  useEffect(() => {
    if (selectedSessionId) {
      loadSettings(selectedSessionId);
      const currentSession = sessions.find(s => s.id === selectedSessionId);
      if (currentSession) {
        setCrmRecipient(currentSession.recipient || '');
        setCrmToken(currentSession.token || '');
        setCrmNote('');
      }
    } else {
      resetSettingsForm();
      setCrmRecipient('');
      setCrmToken('');
      setCrmNote('');
    }
  }, [selectedSessionId, sessions]);

  const loadSettings = async (sessionId) => {
    setSettingsNote('Carregando configurações...');
    const response = await apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/settings`);
    if (response.ok && response.data?.settings) {
      const webhook = response.data.settings.webhook || {};
      setWebhookEnabled(!!webhook.enabled);
      setWebhookUrl(webhook.url || '');
      setWebhookSecret(webhook.secret || '');
      setAllowPrivate(webhook.allowPrivate !== false);
      setAllowGroups(webhook.allowGroups !== false);
      setAllowNewsletters(!!webhook.allowNewsletters);
      setAllowBroadcasts(!!webhook.allowBroadcasts);
      setIncludeFromMe(!!webhook.includeFromMe);
      setSettingsNote(buildSettingsNote(webhook, sessionId));
    } else {
      setSettingsNote(response.error || 'Falha ao carregar configurações.');
    }
  };

  const resetSettingsForm = () => {
    setWebhookEnabled(false);
    setWebhookUrl('');
    setWebhookSecret('');
    setAllowPrivate(true);
    setAllowGroups(true);
    setAllowNewsletters(false);
    setAllowBroadcasts(false);
    setIncludeFromMe(false);
    setSettingsNote('Selecione uma sessão para configurar o webhook dela.');
  };

  const buildSettingsNote = (webhook, sessionId) => {
    const { friendlyId } = parseSessionInfo(sessionId, sessionId);
    if (!webhook.enabled) {
      return `Webhook desativado para a sessão ${friendlyId}.`;
    }
    if (!webhook.url) {
      return `Webhook ativo, mas sem URL configurada para a sessão ${friendlyId}.`;
    }
    return `Webhook ativo para a sessão ${friendlyId}. Novas mensagens serão enviadas para a URL configurada.`;
  };

  const handleCreateSession = async (e) => {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;

    setIsSubmitting(true);
    setSessionNote('');

    if (platform === 'instagram') {
      const cleanPassword = password.trim();
      if (!cleanPassword) {
        setSessionNote('Informe a senha para logar no Instagram.');
        setIsSubmitting(false);
        return;
      }

      setSessionNote('Logando no Instagram...');
      const response = await apiRequest('/api/instagram/login', {
        method: 'POST',
        body: JSON.stringify({ username: cleanName, password: cleanPassword })
      });

      setIsSubmitting(false);

      if (!response.ok) {
        if (response.isCheckpoint) {
          setSessionNote('Checkpoint necessário. Por favor, vá para a aba do Instagram no menu lateral para resolver o desafio.');
        } else {
          setSessionNote(response.error || 'Erro ao realizar login no Instagram.');
        }
        return;
      }

      setName('');
      setPassword('');
      setSessionNote('Sessão do Instagram criada com sucesso!');
      onRefreshSessions();
    } else {
      const response = await apiRequest('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: cleanName,
          recipient: recipient.trim() || null,
          token: token.trim() || null
        })
      });

      setIsSubmitting(false);

      if (!response.ok) {
        setSessionNote(response.error || 'Não foi possível criar a sessão.');
        return;
      }

      setName('');
      setRecipient('');
      setToken('');
      setSessionNote('Sessão criada. Clique em conectar para gerar o QR.');
      setSelectedSessionId(response.data.session.id);
      onRefreshSessions();
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    if (!selectedSessionId) return;

    setIsSavingSettings(true);
    setSettingsNote('Salvando configurações...');

    const payload = {
      webhook: {
        enabled: webhookEnabled,
        url: webhookUrl.trim(),
        secret: webhookSecret.trim(),
        allowPrivate,
        allowGroups,
        allowNewsletters,
        allowBroadcasts,
        includeFromMe
      }
    };

    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    setIsSavingSettings(false);

    if (response.ok && response.data?.settings) {
      const webhook = response.data.settings.webhook || {};
      setSettingsNote('Configurações salvas.');
      setTimeout(() => {
        setSettingsNote(buildSettingsNote(webhook, selectedSessionId));
      }, 2000);
    } else {
      setSettingsNote(response.error || 'Erro ao salvar as configurações.');
    }
  };

  const handleSaveCrmSettings = async (e) => {
    e.preventDefault();
    if (!selectedSessionId) return;

    setIsSavingCrmSettings(true);
    setCrmNote('Salvando configurações CRM...');

    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        recipient: crmRecipient.trim() || null,
        token: crmToken.trim() || null
      })
    });

    setIsSavingCrmSettings(false);

    if (response.ok) {
      setCrmNote('Configurações CRM salvas com sucesso.');
      onRefreshSessions();
      setTimeout(() => {
        setCrmNote('');
      }, 3000);
    } else {
      setCrmNote(response.error || 'Erro ao salvar as configurações CRM.');
    }
  };

  const runSessionAction = async (action, successMsg) => {
    if (!selectedSessionId) return;
    
    setSessionNote(`Executando ação...`);
    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}/${action}`, {
      method: 'POST'
    });

    if (response.ok) {
      setSessionNote(successMsg);
      onRefreshSessions();
    } else {
      setSessionNote(response.error || 'Falha ao executar ação.');
    }
  };

  const handleDeleteSession = async () => {
    if (!selectedSessionId) return;
    if (!window.confirm('Excluir esta sessão apagará permanentemente o histórico local desta conta. Deseja continuar?')) {
      return;
    }

    setSessionNote('Excluindo sessão...');
    const response = await apiRequest(`/api/sessions/${encodeURIComponent(selectedSessionId)}`, {
      method: 'DELETE'
    });

    if (response.ok) {
      setSessionNote('Sessão excluída com sucesso.');
      setSelectedSessionId('');
      onRefreshSessions();
    } else {
      setSessionNote(response.error || 'Falha ao excluir sessão.');
    }
  };

  const handleLogoutSession = async () => {
    if (!selectedSessionId) return;
    if (!window.confirm('Isso vai limpar a autenticação ativa. Tem certeza?')) {
      return;
    }
    await runSessionAction('logout', 'Sessão resetada.');
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case 'connected': return 'badge-success';
      case 'qr': return 'badge-warning';
      case 'connecting': return 'badge-info';
      case 'disconnected': return 'badge-error';
      case 'logged_out': return 'badge-error';
      default: return 'badge-info';
    }
  };

  return (
    <div className="tab-container sessions-tab">
      <div className="tab-sidebar">
        <div className="sidebar-header">
          <h3>Nova Conexão</h3>
        </div>
        
        <form onSubmit={handleCreateSession} className="session-create-form">
          <div className="form-group">
            <label className="form-label">Plataforma</label>
            <select 
              className="input-field" 
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value);
                setSessionNote('');
              }}
            >
              <option value="whatsapp">WhatsApp Web</option>
              <option value="instagram">Instagram Direct</option>
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">
              {platform === 'instagram' ? 'Usuário do Instagram' : 'Nome do Dispositivo'}
            </label>
            <input
              type="text"
              className="input-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={platform === 'instagram' ? 'Ex: @eliejosuevargas2005' : 'Ex: Celular Principal'}
              required
            />
          </div>

          {platform === 'instagram' && (
            <div className="form-group">
              <label className="form-label">Senha do Instagram</label>
              <input
                type="password"
                className="input-field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Sua senha..."
                required
              />
            </div>
          )}
          {platform === 'whatsapp' && (
            <>
              <div className="form-group">
                <label className="form-label">Destinatário CRM (Opcional)</label>
                <input
                  type="text"
                  className="input-field"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Ex: usuario_crm_123"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Token CRM (Opcional)</label>
                <input
                  type="text"
                  className="input-field"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Ex: 123sksdisn..."
                />
              </div>
            </>
          )}
          <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={isSubmitting}>
            <Plus size={16} />
            {isSubmitting ? 'Processando...' : 'Adicionar Conta'}
          </button>
        </form>

        <div className="sidebar-header" style={{ marginTop: '24px' }}>
          <h3>Contas Ativas</h3>
          <button onClick={onRefreshSessions} className="icon-btn" title="Atualizar">
            <RefreshCw size={16} />
          </button>
        </div>

        <div className="sessions-list scrollable">
          {sessions.length === 0 ? (
            <div className="empty-message">Nenhuma sessão criada.</div>
          ) : (
            sessions.map((session) => {
              const { userHash, friendlyId, friendlyName, isNamespaced } = parseSessionInfo(session.id, session.name);
              return (
                <div
                  key={session.id}
                  className={`session-list-item ${selectedSessionId === session.id ? 'active' : ''}`}
                  onClick={() => setSelectedSessionId(session.id)}
                >
                  <div className="session-item-header">
                    <span className="session-item-name">{friendlyName}</span>
                    <span className={`badge ${getStatusBadgeClass(session.snapshot?.status || 'idle')}`}>
                      {formatStatus(session.snapshot?.status || 'idle')}
                    </span>
                  </div>
                  <div className="session-item-meta">
                    <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                      ID: {friendlyId}
                      {isNamespaced && (
                        <span style={{
                          fontSize: '0.7rem',
                          padding: '1px 6px',
                          backgroundColor: 'rgba(59, 130, 246, 0.15)',
                          color: '#60a5fa',
                          borderRadius: '4px',
                          fontWeight: '600',
                          fontFamily: 'monospace'
                        }} title={`Pertence ao usuário com hash ${userHash}`}>
                          {userHash}
                        </span>
                      )}
                    </span>
                    <span className="platform-tag">{session.platform || 'whatsapp'}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="tab-main-panel">
        {selectedSession ? (
          <div className="session-details-layout">
            <div className="details-header glass-panel">
              <div className="details-title-row">
                <h2>{parseSessionInfo(selectedSession.id, selectedSession.name).friendlyName}</h2>
                <div className="details-actions">
                  {selectedSession.platform !== 'instagram' && selectedSession.snapshot?.status !== 'connected' && (
                    <button 
                      onClick={() => runSessionAction('connect', 'Solicitação de conexão enviada.')} 
                      className="btn btn-whatsapp btn-sm"
                    >
                      <Power size={14} /> Conectar
                    </button>
                  )}
                  <button onClick={handleLogoutSession} className="btn btn-secondary btn-sm">
                    <LogOut size={14} /> Desconectar
                  </button>
                  <button onClick={handleDeleteSession} className="btn btn-danger btn-sm">
                    <Trash2 size={14} /> Excluir
                  </button>
                </div>
              </div>
              <div className="details-status-row">
                <span>Status:</span>
                <span className={`badge ${getStatusBadgeClass(selectedSession.snapshot?.status || 'idle')}`}>
                  {formatStatus(selectedSession.snapshot?.status || 'idle')}
                </span>
                <span className="divider">|</span>
                <span>Plataforma:</span>
                <span className="platform-tag">{selectedSession.platform || 'whatsapp'}</span>
                {selectedSession.recipient && (
                  <>
                    <span className="divider">|</span>
                    <span>Destinatário CRM:</span>
                    <span className="platform-tag" style={{ backgroundColor: '#2563eb', color: 'white' }}>{selectedSession.recipient}</span>
                  </>
                )}
                {selectedSession.token && (
                  <>
                    <span className="divider">|</span>
                    <span>Token:</span>
                    <span className="platform-tag" style={{ backgroundColor: '#475569', color: 'white' }} title={selectedSession.token}>✓ Configurado</span>
                  </>
                )}
              </div>
              
              {sessionNote && <div className="session-info-note">{sessionNote}</div>}
            </div>

            <div className="details-grid">
              {/* Connection status card (QR / Confirmation) */}
              <div className="detail-card qr-card glass-panel">
                <h3>Conexão do Dispositivo</h3>
                
                <div className="qr-container">
                  {selectedSession.platform === 'instagram' ? (
                    <div className="instagram-status-screen">
                      <Shield size={48} className="instagram-icon-status" />
                      <p>Conta do Instagram logada via instagrapi.</p>
                      <span className="sub">Você pode enviar e receber mensagens pela aba correspondente.</span>
                    </div>
                  ) : (
                    <>
                      {selectedSession.snapshot?.status === 'connected' ? (
                        <div className="whatsapp-connected-screen">
                          <Power size={48} className="whatsapp-icon-status" />
                          <p>Conectado e pronto para uso!</p>
                          <span className="sub">Conversas sincronizadas.</span>
                        </div>
                      ) : selectedSession.snapshot?.qrDataUrl ? (
                        <div className="qr-box">
                          <img src={selectedSession.snapshot.qrDataUrl} alt="Escaneie o QR Code" />
                          <p className="qr-instructions">Abra o WhatsApp no celular {`>`} Aparelhos conectados {`>`} Conectar aparelho e aponte para a tela.</p>
                        </div>
                      ) : (
                        <div className="qr-placeholder">
                          <RefreshCw size={32} className="spinner" />
                          <p>Aguardando resposta do WhatsApp...</p>
                          <span className="sub">Clique em Conectar se o QR code não carregar.</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Statistics card */}
              <div className="detail-card stats-card glass-panel">
                <h3>Métricas Locais</h3>
                <div className="stats-grid">
                  <div className="stat-box">
                    <span className="stat-label">Conversas</span>
                    <span className="stat-val">{selectedSession.stats?.conversationCount || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Mensagens</span>
                    <span className="stat-val">{selectedSession.stats?.messageCount || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Não Lidas</span>
                    <span className="stat-val">{selectedSession.stats?.unreadCount || 0}</span>
                  </div>
                  <div className="stat-box">
                    <span className="stat-label">Conta ID</span>
                    <span className="stat-val text-truncate" title={selectedSession.snapshot?.accountId || '-'}>
                      {selectedSession.snapshot?.accountId || '-'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Webhook configuration card */}
              <div className="detail-card webhook-card glass-panel">
                <h3>Configurações de Webhook</h3>
                <form onSubmit={handleSaveSettings}>
                  <div className="form-group checkbox-group">
                    <label className="checkbox-label">
                      <input 
                        type="checkbox" 
                        className="checkbox-input"
                        checked={webhookEnabled}
                        onChange={(e) => setWebhookEnabled(e.target.checked)}
                      />
                      Ativar Webhook para esta sessão
                    </label>
                  </div>

                  <div className="form-group">
                    <label className="form-label">URL do Webhook</label>
                    <input 
                      type="url" 
                      className="input-field"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://seu-servidor.com/webhook"
                      required={webhookEnabled}
                      disabled={!webhookEnabled}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Segredo do Webhook (Assinatura SHA256)</label>
                    <input 
                      type="text" 
                      className="input-field"
                      value={webhookSecret}
                      onChange={(e) => setWebhookSecret(e.target.value)}
                      placeholder="Chave secreta para validação..."
                      disabled={!webhookEnabled}
                    />
                  </div>

                  <div className="webhook-filters">
                    <span className="section-title">Tipos de Conversa a Sincronizar:</span>
                    <div className="checkbox-grid">
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={allowPrivate}
                          onChange={(e) => setAllowPrivate(e.target.checked)}
                          disabled={!webhookEnabled}
                        />
                        Privado (1-para-1)
                      </label>
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={allowGroups}
                          onChange={(e) => setAllowGroups(e.target.checked)}
                          disabled={!webhookEnabled}
                        />
                        Grupos
                      </label>
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={allowNewsletters}
                          onChange={(e) => setAllowNewsletters(e.target.checked)}
                          disabled={!webhookEnabled}
                        />
                        Canais/Newsletters
                      </label>
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={allowBroadcasts}
                          onChange={(e) => setAllowBroadcasts(e.target.checked)}
                          disabled={!webhookEnabled}
                        />
                        Listas de Transmissão
                      </label>
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          className="checkbox-input"
                          checked={includeFromMe}
                          onChange={(e) => setIncludeFromMe(e.target.checked)}
                          disabled={!webhookEnabled}
                        />
                        Enviar Minhas Mensagens (fromMe)
                      </label>
                    </div>
                  </div>

                  <button type="submit" className="btn btn-primary btn-sm" disabled={isSavingSettings} style={{ marginTop: '12px' }}>
                    <Save size={14} />
                    {isSavingSettings ? 'Salvando...' : 'Salvar Configurações'}
                  </button>
                </form>
                {settingsNote && <div className="settings-info-note">{settingsNote}</div>}
              </div>

              {/* CRM configuration card */}
              <div className="detail-card crm-card glass-panel">
                <h3>Integração CRM (DominusLabs)</h3>
                <form onSubmit={handleSaveCrmSettings}>
                  <div className="form-group">
                    <label className="form-label">Destinatário (Identificador de Usuário)</label>
                    <input 
                      type="text" 
                      className="input-field"
                      value={crmRecipient}
                      onChange={(e) => setCrmRecipient(e.target.value)}
                      placeholder="Ex: usuario_crm_123"
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">Token de Autenticação</label>
                    <input 
                      type="text" 
                      className="input-field"
                      value={crmToken}
                      onChange={(e) => setCrmToken(e.target.value)}
                      placeholder="Ex: 123sksdisn..."
                    />
                  </div>

                  <button type="submit" className="btn btn-primary btn-sm" disabled={isSavingCrmSettings} style={{ marginTop: '12px' }}>
                    <Save size={14} />
                    {isSavingCrmSettings ? 'Salvando...' : 'Salvar Alterações CRM'}
                  </button>
                </form>
                {crmNote && <div className="settings-info-note">{crmNote}</div>}
              </div>

              {/* M2M API Credentials card */}
              <div className="detail-card m2m-card glass-panel">
                <h3>Credenciais de Integração API (M2M)</h3>
                <div style={{ marginBottom: '16px', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  Use estas credenciais para se autenticar e consumir a API de forma programática ou manual usando tokens RSA.
                </div>

                {m2mHasCredentials ? (
                  <div className="form-group" style={{ marginBottom: '16px' }}>
                    <label className="form-label">Client ID Ativo</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input 
                        type="text" 
                        className="input-field" 
                        value={m2mClientId} 
                        readOnly 
                        style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
                      />
                      <button 
                        type="button" 
                        className="btn btn-secondary btn-sm" 
                        onClick={() => {
                          navigator.clipboard.writeText(m2mClientId);
                          alert('Client ID copiado para a área de transferência!');
                        }}
                      >
                        Copiar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: '16px', padding: '10px', backgroundColor: 'rgba(239, 68, 68, 0.1)', borderRadius: '4px', fontSize: '0.85rem', color: '#f87171' }}>
                    Nenhuma credencial M2M ativa encontrada. Utilize o formulário abaixo para gerar.
                  </div>
                )}

                {m2mSecretResponse && (
                  <div style={{ marginBottom: '16px', padding: '12px', backgroundColor: 'rgba(34, 197, 94, 0.15)', border: '1px solid rgba(34, 197, 94, 0.3)', borderRadius: '6px' }}>
                    <strong style={{ color: '#4ade80', fontSize: '0.9rem', display: 'block', marginBottom: '6px' }}>
                      Atenção: Salve o Client Secret abaixo!
                    </strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                      Por questões de segurança, ele é armazenado de forma criptografada e não poderá ser exibido novamente.
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Client Secret</label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input 
                          type="text" 
                          className="input-field" 
                          value={m2mSecretResponse} 
                          readOnly 
                          style={{ fontFamily: 'monospace', fontSize: '0.8rem', backgroundColor: '#1e293b', color: '#4ade80' }}
                        />
                        <button 
                          type="button" 
                          className="btn btn-success btn-sm" 
                          onClick={() => {
                            navigator.clipboard.writeText(m2mSecretResponse);
                            alert('Client Secret copiado!');
                          }}
                        >
                          Copiar
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <form onSubmit={handleGenerateM2m} style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '16px' }}>
                  <div className="form-group">
                    <label className="form-label">Senha do Painel (para confirmar)</label>
                    <input 
                      type="password" 
                      className="input-field" 
                      value={m2mPasswordInput} 
                      onChange={(e) => setM2mPasswordInput(e.target.value)}
                      placeholder="Digite a sua senha do painel..."
                      required
                    />
                  </div>

                  <button type="submit" className="btn btn-primary btn-sm" disabled={isGeneratingM2m} style={{ marginTop: '8px', width: '100%' }}>
                    {isGeneratingM2m ? 'Gerando...' : m2mHasCredentials ? 'Gerar Novas Credenciais' : 'Gerar Credenciais Iniciais'}
                  </button>
                </form>
                {m2mNote && <div className="settings-info-note" style={{ marginTop: '10px' }}>{m2mNote}</div>}
              </div>
            </div>
          </div>
        ) : (
          <div className="empty-state-panel">
            <Settings size={64} className="empty-icon" />
            <h2>Nenhuma Sessão Selecionada</h2>
            <p>Escolha uma conta ativa na lista lateral ou registre uma nova conexão.</p>
          </div>
        )}
      </div>
    </div>
  );
}
