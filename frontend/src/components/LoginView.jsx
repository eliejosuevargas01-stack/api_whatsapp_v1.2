import React, { useState } from 'react';
import { Mail, Lock, ArrowRight, Loader2 } from 'lucide-react';
import { apiRequest } from '../shared/api';

export default function LoginView({ onLoginSuccess }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Por favor, preencha todos os campos.');
      return;
    }

    setLoading(true);
    setError('');

    const response = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: email,
        password: password
      })
    });

    setLoading(false);

    if (response.ok && response.data?.whatsapp_token) {
      localStorage.setItem('whatsapp_session_token', response.data.whatsapp_token);
      onLoginSuccess();
    } else {
      setError(response.error || 'Credenciais inválidas ou erro ao conectar com o CRM.');
    }
  };

  return (
    <div className="login-wrapper" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100vw',
      height: '100vh',
      background: 'radial-gradient(circle at 50% 50%, #13161c 0%, #0a0c10 100%)',
      position: 'fixed',
      top: 0,
      left: 0,
      zIndex: 9999,
      fontFamily: 'var(--font-sans)'
    }}>
      <div className="glass-panel login-card" style={{
        width: '100%',
        maxWidth: '440px',
        padding: '40px',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius-lg)',
        boxShadow: 'var(--glass-shadow)',
        background: 'var(--glass-bg)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        animation: 'fadeIn 0.5s ease-out'
      }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            fontSize: '2.5rem',
            fontWeight: '800',
            fontFamily: 'var(--font-heading)',
            background: 'var(--accent-gradient)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            marginBottom: '8px',
            letterSpacing: '-0.03em'
          }}>
            OmniConnect
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.925rem' }}>
            Gerenciador de Sessões unificado da Dominuslabs
          </p>
        </div>

        {error && (
          <div className="badge-error" style={{
            padding: '12px 16px',
            borderRadius: 'var(--border-radius-sm)',
            fontSize: '0.85rem',
            color: 'var(--color-error)',
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            marginBottom: '24px',
            lineHeight: '1.4',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Mail size={12} style={{ color: 'var(--text-muted)' }} /> E-mail de Admin
            </label>
            <input
              type="email"
              className="input-field"
              placeholder="exemplo@dominuslabs.online"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
              style={{
                width: '100%',
                padding: '12px 14px',
                marginTop: '6px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Lock size={12} style={{ color: 'var(--text-muted)' }} /> Senha
            </label>
            <input
              type="password"
              className="input-field"
              placeholder="Digite sua senha do CRM"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
              style={{
                width: '100%',
                padding: '12px 14px',
                marginTop: '6px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              fontSize: '0.938rem',
              fontWeight: '600',
              borderRadius: 'var(--border-radius-sm)',
              marginTop: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.8 : 1,
              transition: 'all 0.2s ease-in-out'
            }}
          >
            {loading ? (
              <>
                <Loader2 className="animate-spin" size={18} />
                Autenticando com o CRM...
              </>
            ) : (
              <>
                Entrar
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        <div style={{
          textAlign: 'center',
          marginTop: '32px',
          fontSize: '0.75rem',
          color: 'var(--text-muted)'
        }}>
          OmniConnect &copy; 2026. Acesso restrito a administradores.
        </div>
      </div>
    </div>
  );
}
