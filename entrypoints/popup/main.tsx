import '@src/ui/theme/tokens.css';
import { applyStoredUiTheme } from '@src/ui/theme/themes';
import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@src/ui/components/ErrorBoundary';
import { PopupApp } from '@src/ui/popup/PopupApp';

applyStoredUiTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <PopupApp />
    </ErrorBoundary>
  </StrictMode>,
);
