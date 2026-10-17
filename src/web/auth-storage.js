/**
 * The web build's stand-in for electron/auth-storage.js.
 *
 * In a browser, supabase-js already knows how to keep its session in
 * localStorage, so there is nothing to adapt: handing it `undefined` picks
 * that default. Writes are synchronous, so there is never one to wait on.
 */
export const storage = undefined;
export const pendingWrites = () => Promise.resolve();
