/**
 * Installable-app plumbing for the website.
 *
 * The service worker (generated at build time - see `serviceWorker()` in
 * vite.web.config.mjs) keeps a copy of the app itself, so the site opens with
 * no connection and can be added to a phone's home screen. Library data was
 * never on the network to begin with; it lives in IndexedDB.
 *
 * Not registered by the dev server: a worker caching the app would fight
 * with hot reload.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[game-ranker] offline support is unavailable:', err);
    });
  });
}
