import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { App } from './App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App routing and shell', () => {
  it('renders the application shell and complete navigation', () => {
    renderAt('/');
    expect(screen.getByLabelText('Navigation principale')).toBeInTheDocument();
    for (const label of [
      'Dashboard',
      'Profils',
      'Simulation',
      'Historique',
      'Intégrations',
      'Paramètres',
    ]) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    for (const label of ['Documentation', 'À propos', 'GitHub']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the matching sidebar entry as active', () => {
    renderAt('/profiles/example');
    expect(screen.getByRole('link', { name: 'Profils' })).toHaveClass('is-active');
    expect(screen.getByRole('heading', { name: 'Éditeur de profil' })).toBeInTheDocument();
  });

  it('navigates with the sidebar and renders placeholders', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('link', { name: 'Simulation' }));
    expect(screen.getByRole('heading', { name: 'Simulation' })).toBeInTheDocument();
    expect(screen.getByText('Structure prête')).toBeInTheDocument();
  });

  it('renders a controlled unknown-route page', () => {
    renderAt('/destination-inconnue');
    expect(screen.getByRole('heading', { name: 'Page introuvable' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Retour au Dashboard' })).toHaveAttribute('href', '/');
  });
});
