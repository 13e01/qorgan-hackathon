import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/opsz.css';
import './styles.css';
import './eclipse.css';
import { Root } from './Root';
import { I18nProvider } from './i18n';
import { DemoProvider } from './state/demo';
import { StoreProvider } from './state/store';
import { ThemeProvider } from './state/theme';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <StoreProvider>
          <DemoProvider>
            <Root />
          </DemoProvider>
        </StoreProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
