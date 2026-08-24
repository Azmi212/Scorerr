import { useEffect, useState } from 'react';
import {
  CircleHelp,
  FileText,
  Gauge,
  CodeXml,
  History,
  Info,
  Menu,
  PanelLeftClose,
  Plug,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Button } from '../components/Button';

const navigation = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/profiles', label: 'Profils', icon: Sparkles },
  { to: '/simulation', label: 'Simulation', icon: SlidersHorizontal },
  { to: '/history', label: 'Historique', icon: History },
  { to: '/integrations', label: 'Intégrations', icon: Plug },
  { to: '/settings', label: 'Paramètres', icon: Settings },
] as const;

const resources = [
  { to: '/documentation', label: 'Documentation', icon: FileText },
  { to: '/about', label: 'À propos', icon: Info },
  { to: '/github', label: 'GitHub', icon: CodeXml },
] as const;

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      ≋
    </span>
  );
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  const renderLink = ({ to, label, icon: Icon, ...link }: (typeof navigation)[number]) => (
    <NavLink
      key={to}
      to={to}
      {...('end' in link ? { end: link.end } : {})}
      className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}
    >
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
    </NavLink>
  );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Aller au contenu
      </a>
      <header className="mobile-header">
        <div className="mobile-brand">
          <BrandMark />
          <span>scorerr</span>
        </div>
        <Button
          variant="ghost"
          iconOnly
          aria-label={sidebarOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'}
          onClick={() => {
            setSidebarOpen((open) => !open);
          }}
        >
          {sidebarOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </Button>
      </header>
      {sidebarOpen ? (
        <button
          className="sidebar-backdrop"
          aria-label="Fermer la navigation"
          onClick={() => {
            setSidebarOpen(false);
          }}
        />
      ) : null}
      <aside
        className={`sidebar${sidebarOpen ? ' is-open' : ''}`}
        aria-label="Navigation principale"
      >
        <div className="sidebar-brand" aria-label="scorerr">
          <BrandMark />
          <span>scorerr</span>
          <PanelLeftClose size={16} aria-hidden="true" />
        </div>
        <button className="sidebar-search" type="button" aria-label="Rechercher">
          <Search size={19} aria-hidden="true" />
          <span>Rechercher</span>
          <kbd>⌘ K</kbd>
        </button>
        <nav className="sidebar-nav" aria-label="Sections">
          {navigation.map(renderLink)}
        </nav>
        <nav className="sidebar-nav sidebar-resources" aria-label="Ressources">
          {resources.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}
            >
              <Icon size={18} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-profile">
          <span className="sidebar-avatar">
            <UserRound size={19} aria-hidden="true" />
          </span>
          <span>
            <strong>Instance locale</strong>
            <small>Sans authentification</small>
          </span>
          <CircleHelp size={17} aria-hidden="true" />
        </div>
      </aside>
      <main id="main-content" className="app-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
