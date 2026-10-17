/**
 * Which shell the app is running in. The desktop bridge (electron/preload.js)
 * has no `platform`; the website's (src/web/api.js) says 'web'. Read once at
 * load - the bridge is installed before any of the app's modules run.
 */
export const IS_WEB = typeof window !== 'undefined' && window.api?.platform === 'web';
