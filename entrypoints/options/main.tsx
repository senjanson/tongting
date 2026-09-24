import '@src/ui/theme/tokens.css';
import { applyStoredUiTheme } from '@src/ui/theme/themes';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from '@src/ui/components/ErrorBoundary';
import { OptionsApp } from '@src/ui/options/OptionsApp';

applyStoredUiTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <OptionsApp />
    </ErrorBoundary>
  </StrictMode>,
);
