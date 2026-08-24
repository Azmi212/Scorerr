import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

import { Button } from '../components/Button';

const figmaAssetRoot = '/assets/figma/dashboard';

interface SidebarEntry {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const navigation: SidebarEntry[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard.svg', end: true },
  { to: '/profiles', label: 'Profils', icon: 'profiles.svg' },
  { to: '/simulation', label: 'Simulation', icon: 'simulation.svg' },
  { to: '/history', label: 'Historique', icon: 'history.svg' },
  { to: '/integrations', label: 'Intégrations', icon: 'integrations.svg' },
  { to: '/settings', label: 'Paramètres', icon: 'settings.svg' },
];

const resources: SidebarEntry[] = [
  { to: '/documentation', label: 'Documentation', icon: 'documentation.svg' },
  { to: '/about', label: 'À propos', icon: 'about.svg' },
  { to: '/github', label: 'GitHub', icon: 'github.svg' },
];

function FigmaIcon({ asset, className }: { asset: string; className?: string }) {
  const resolvedClassName = className ?? 'sidebar-icon';

  if (asset === 'simulation.svg') {
    return (
      <span className={`${resolvedClassName} sidebar-simulation-icon`} aria-hidden="true">
        <img src={`${figmaAssetRoot}/${asset}`} alt="" />
      </span>
    );
  }

  return (
    <img
      className={resolvedClassName}
      src={`${figmaAssetRoot}/${asset}`}
      alt=""
      aria-hidden="true"
    />
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <FigmaIcon asset="brand-verification.svg" className="brand-mark-icon" />
    </span>
  );
}

function SidebarLink({ to, label, icon, end }: SidebarEntry) {
  const linkEnd = end === undefined ? {} : { end };

  return (
    <NavLink
      to={to}
      {...linkEnd}
      className={({ isActive }) => `sidebar-link${isActive ? ' is-active' : ''}`}
    >
      <FigmaIcon asset={icon} />
      <span>{label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Aller au contenu
      </a>
      <header className="mobile-header">
        <div className="mobile-brand">
          <BrandMark />
          <span>Scorerr</span>
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
        <div className="sidebar-top">
          <div className="sidebar-brand" aria-label="Scorerr">
            <span className="sidebar-brand-copy">
              <BrandMark />
              <span className="sidebar-brand-name">Scorerr</span>
            </span>
            <FigmaIcon asset="brand-chevron.svg" className="sidebar-brand-chevron" />
          </div>
          <button className="sidebar-search" type="button" aria-label="Rechercher">
            <span className="sidebar-search-copy">
              <FigmaIcon asset="search.svg" />
              <span>Rechercher</span>
            </span>
            <kbd className="sidebar-command">
              <FigmaIcon asset="command.svg" className="sidebar-command-icon" />
              <span>K</span>
            </kbd>
          </button>
          <div className="sidebar-menu-groups">
            <nav className="sidebar-nav" aria-label="Sections">
              {navigation.map((item) => (
                <SidebarLink key={item.to} {...item} />
              ))}
            </nav>
            <nav className="sidebar-nav sidebar-resources" aria-label="Ressources">
              {resources.map((item) => (
                <SidebarLink key={item.to} {...item} />
              ))}
            </nav>
          </div>
        </div>
        <div className="sidebar-profile" aria-label="Instance locale sans authentification">
          <span className="sidebar-avatar" aria-hidden="true">
            <span className="sidebar-avatar-shape">
              <FigmaIcon asset="account.svg" className="sidebar-avatar-icon" />
            </span>
          </span>
          <span className="sidebar-profile-copy">
            <strong>Instance locale</strong>
            <small>Sans authentification</small>
          </span>
          <FigmaIcon asset="user-menu.svg" className="sidebar-user-menu" />
        </div>
      </aside>
      <main id="main-content" className="app-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
