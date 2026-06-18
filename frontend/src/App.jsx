import React, { useState, useEffect } from 'react';
import NavigationRail from './components/NavigationRail';
import WhatsAppTab from './components/WhatsAppTab';
import InstagramTab from './components/InstagramTab';
import SessionsTab from './components/SessionsTab';
import LoginView from './components/LoginView';
import { apiRequest, loadPanelState, savePanelState } from './shared/api';

export default function App() {
  const [theme, setTheme] = useState('dark');
  const [activeTab, setActiveTab] = useState('whatsapp');
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('whatsapp_session_token'));

  // Initialize theme and tab from localStorage
  useEffect(() => {
    const saved = loadPanelState();
    const savedTheme = saved.theme || 'dark';
    const savedTab = saved.activeTab || 'whatsapp';
    const savedSessionId = saved.selectedSessionId || '';
    
    setTheme(savedTheme);
    setActiveTab(savedTab);
    setSelectedSessionId(savedSessionId);
    
    // Set theme class on body
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }

    if (isAuthenticated) {
      refreshSessions();
    }
  }, [isAuthenticated]);

  // Poll sessions list
  useEffect(() => {
    if (!isAuthenticated) return;

    const timer = setInterval(() => {
      refreshSessions();
    }, 8000);

    return () => clearInterval(timer);
  }, [isAuthenticated]);

  // Listen for unauthorized events (automatic logout)
  useEffect(() => {
    const handleUnauthorized = () => {
      setIsAuthenticated(false);
    };

    window.addEventListener('auth-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth-unauthorized', handleUnauthorized);
  }, []);

  // Sync active tab selection to localStorage
  const handleSelectTab = (tab) => {
    setActiveTab(tab);
    savePanelState({ activeTab: tab });
  };

  const handleToggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    savePanelState({ theme: nextTheme });
    
    if (nextTheme === 'light') {
      document.body.classList.add('light-theme');
    } else {
      document.body.classList.remove('light-theme');
    }
  };

  const refreshSessions = async () => {
    const response = await apiRequest('/api/sessions');
    if (response.ok && response.data?.sessions) {
      setSessions(response.data.sessions);
    }
  };

  const handleSelectSession = (id) => {
    setSelectedSessionId(id);
    savePanelState({ selectedSessionId: id });
  };

  const handleLogout = () => {
    localStorage.removeItem('whatsapp_session_token');
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return <LoginView onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="app-container">
      <NavigationRail
        activeTab={activeTab}
        setActiveTab={handleSelectTab}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onLogout={handleLogout}
      />
      
      <main className="main-content">
        {activeTab === 'whatsapp' && (
          <WhatsAppTab
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            setSelectedSessionId={handleSelectSession}
          />
        )}
        
        {activeTab === 'instagram' && (
          <InstagramTab
            sessions={sessions}
            onRefreshSessions={refreshSessions}
            selectedSessionId={selectedSessionId}
            setSelectedSessionId={handleSelectSession}
          />
        )}
        
        {activeTab === 'sessions' && (
          <SessionsTab
            sessions={sessions}
            onRefreshSessions={refreshSessions}
            selectedSessionId={selectedSessionId}
            setSelectedSessionId={handleSelectSession}
          />
        )}
      </main>
    </div>
  );
}
