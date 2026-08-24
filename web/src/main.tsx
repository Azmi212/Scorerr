import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './app/App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/dashboard.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
