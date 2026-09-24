import '@src/ui/theme/tokens.css';
import { applyStoredUiTheme } from '@src/ui/theme/themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@src/ui/components/ErrorBoundary';
import { SidePanelApp } from '@src/ui/sidepanel/SidePanelApp';

applyStoredUiTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <SidePanelApp />
    </ErrorBoundary>
  </StrictMode>,
);
