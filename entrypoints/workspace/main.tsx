import '@src/ui/theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@src/ui/components/ErrorBoundary';
import { WorkspaceApp } from '@src/ui/workspace/WorkspaceApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <WorkspaceApp />
    </ErrorBoundary>
  </StrictMode>,
);
