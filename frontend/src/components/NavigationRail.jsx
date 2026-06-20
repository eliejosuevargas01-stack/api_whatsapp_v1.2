import React from 'react';
import { MessageSquare, Settings, Sun, Moon, LogOut } from 'lucide-react';

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


export default function NavigationRail({ activeTab, setActiveTab, theme, onToggleTheme, onLogout }) {
  const tabs = [
    { id: 'whatsapp', name: 'WhatsApp', icon: MessageSquare },
    { id: 'sessions', name: 'Sessões & Webhooks', icon: Settings },
  ];

  return (
    <div className="nav-rail">
      <div className="nav-logo" title="Whats Api">
        <span>WA</span>
      </div>

      <nav className="nav-items">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              className={`nav-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.name}
            >
              <Icon size={22} />
              {activeTab === tab.id && <div className="nav-indicator" />}
            </button>
          );
        })}
      </nav>

      <div className="nav-footer">
        <button
          className="nav-btn theme-toggle"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Modo Claro' : 'Modo Escuro'}
          style={{ marginBottom: '10px' }}
        >
          {theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />}
        </button>

        <button
          className="nav-btn logout-btn"
          onClick={onLogout}
          title="Sair"
          style={{ color: 'var(--color-error)' }}
        >
          <LogOut size={22} />
        </button>
      </div>
    </div>
  );
}
