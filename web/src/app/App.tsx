import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './AppShell';
import { DesignSystemPage } from '../pages/DesignSystemPage';
import { NotFoundPage, PlaceholderPage } from '../pages/PlaceholderPage';

const pages = [
  { path: '/', title: 'Dashboard', description: 'Vue d’ensemble de scorerr.' },
  { path: '/profiles', title: 'Vos profils', description: 'Gérez vos stratégies de sélection.' },
  {
    path: '/profiles/:id',
    title: 'Éditeur de profil',
    description: 'Personnalisez les règles du profil.',
  },
  {
    path: '/simulation',
    title: 'Simulation',
    description: 'Testez un profil sans lancer de téléchargement.',
  },
  { path: '/history', title: 'Historique', description: 'Consultez les simulations enregistrées.' },
  { path: '/integrations', title: 'Intégrations', description: 'Gérez les connexions de scorerr.' },
  {
    path: '/settings',
    title: 'Paramètres',
    description: 'Personnalisez le comportement de scorerr.',
  },
  {
    path: '/onboarding',
    title: 'Bienvenue',
    description: 'Configurez votre environnement scorerr.',
  },
  { path: '/documentation', title: 'Documentation', description: 'Documentation de scorerr.' },
  { path: '/about', title: 'À propos', description: 'Informations sur scorerr.' },
  { path: '/github', title: 'GitHub', description: 'Projet et contributions.' },
] as const;

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {pages.map((page) => (
          <Route key={page.path} path={page.path} element={<PlaceholderPage {...page} />} />
        ))}
        {import.meta.env.DEV ? (
          <Route path="/__design-system" element={<DesignSystemPage />} />
        ) : null}
        <Route path="/404" element={<NotFoundPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="/index.html" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
