/**
 * The smallest IndexedDB wrapper that does the job: one database, two object
 * stores, promise-returning get/put/delete. IndexedDB rather than
 * localStorage because a library with a few hundred long reviews, and every
 * photo someone has added from their phone, would blow straight through
 * localStorage's ~5 MB.
 *
 *   state   - the library data, keyed 'local' or 'account:<uuid>'
 *   images  - uploaded image Blobs, keyed by their stored file name
 */

const DB_NAME = 'game-ranker';
const DB_VERSION = 1;
export const STATE = 'state';
export const IMAGES = 'images';

let opening = null;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
        if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    // A failed open (private mode on some browsers) must not be cached, or
    // every later call would fail without ever trying again.
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

function run(storeName, mode, action) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const idbPut = (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store) => run(store, 'readonly', (s) => s.getAllKeys());
