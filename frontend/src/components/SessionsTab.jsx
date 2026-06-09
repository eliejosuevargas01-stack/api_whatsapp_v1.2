import React, { useState, useEffect, useRef } from 'react';
import { Plus, RefreshCw, Power, LogOut, Trash2, Save, Settings, Shield } from 'lucide-react';
import { apiRequest, formatStatus } from '../shared/api';

export default function SessionsTab({ sessions, onRefreshSessions, selectedSessionId, setSelectedSessionId }) {
  const [platform, setPlatform] = useState('whatsapp');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionNote, setSessionNote] = useState('');
  
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

  const selectedSession = sessions.find(s => s.id === selectedSessionId) || null;

  // Load settings when session changes
  useEffect(() => {
    if (selectedSessionId) {
      loadSettings(selectedSessionId);
    } else {
      resetSettingsForm();
    }
  }, [selectedSessionId]);

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
    if (!webhook.enabled) {
      return `Webhook desativado para a sessão ${sessionId}.`;
    }
    if (!webhook.url) {
      return `Webhook ativo, mas sem URL configurada para a sessão ${sessionId}.`;
    }
    return `Webhook ativo para a sessão ${sessionId}. Novas mensagens serão enviadas para a URL configurada.`;
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
        body: JSON.stringify({ name: cleanName })
      });

      setIsSubmitting(false);

      if (!response.ok) {
        setSessionNote(response.error || 'Não foi possível criar a sessão.');
        return;
      }

      setName('');
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
            sessions.map((session) => (
              <div
                key={session.id}
                className={`session-list-item ${selectedSessionId === session.id ? 'active' : ''}`}
                onClick={() => setSelectedSessionId(session.id)}
              >
                <div className="session-item-header">
                  <span className="session-item-name">{session.name}</span>
                  <span className={`badge ${getStatusBadgeClass(session.snapshot?.status || 'idle')}`}>
                    {formatStatus(session.snapshot?.status || 'idle')}
                  </span>
                </div>
                <div className="session-item-meta">
                  <span>ID: {session.id}</span>
                  <span className="platform-tag">{session.platform || 'whatsapp'}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="tab-main-panel">
        {selectedSession ? (
          <div className="session-details-layout">
            <div className="details-header glass-panel">
              <div className="details-title-row">
                <h2>{selectedSession.name}</h2>
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
