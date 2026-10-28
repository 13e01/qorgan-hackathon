import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { App } from './App';
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
            <App />
          </DemoProvider>
        </StoreProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
