import { createRoot } from 'react-dom/client';

import './styles/layers.css';
import './styles/umbra.scss';
import './styles/index.css';

import { App, bootstrap } from './app';

bootstrap();

// No StrictMode: its development-only double mount would run each screen's
// constructor-time subscriptions twice and destroy the survivor's (see
// DestroyRef in lib/signals.ts). Production renders once either way.
createRoot(document.getElementById('root')!).render(<App />);
