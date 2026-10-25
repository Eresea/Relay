import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/layers.css';
import './styles/umbra.scss';
import './styles/index.css';

import { App, bootstrap } from './app';

bootstrap();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
