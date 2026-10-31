import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './styles.css';
import './mobile.css';
import './live-only.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveOnlyApp } from './LiveOnlyApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LiveOnlyApp />
  </StrictMode>,
);
