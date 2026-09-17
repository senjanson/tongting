import '@src/ui/theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@src/ui/components/ErrorBoundary';
import { SidePanelApp } from '@src/ui/sidepanel/SidePanelApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <SidePanelApp />
    </ErrorBoundary>
  </StrictMode>,
);
