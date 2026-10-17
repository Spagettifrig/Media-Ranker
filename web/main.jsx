// The bridge has to exist before any of the app's modules run.
import '../src/web/api.js';
import '../src/main.jsx';
import { registerServiceWorker } from '../src/web/pwa.js';

registerServiceWorker();
