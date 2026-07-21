import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';

import App from './App';
import i18n from './i18n';
import { initTheme } from './theme/theme';
import './styles.css';

// Apply the stored theme at boot (the index.html inline script already did this
// pre-paint; this keeps the runtime in sync after hydration).
initTheme();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </StrictMode>,
);
