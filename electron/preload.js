'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /**
   * Read the persisted library for one account (null = signed out, the
   * device's own library). Resolves to { version, libraries, settings }.
   */
  load: (accountId = null) => ipcRenderer.invoke('data:load', accountId),

  /** Persist the whole library for one account. Called on every change (autosave). */
  save: (accountId, state) => ipcRenderer.invoke('data:save', accountId, state),

  /**
   * The window is closing and wants one last save before it goes. Run the
   * callback, then call `flushed()` - the window stays open until you do (or
   * until the main process gives up waiting).
   */
  onFlush: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('data:flush', handler);
    return () => ipcRenderer.removeListener('data:flush', handler);
  },

  /** Tell the main process the final save has been handed over. */
  flushed: () => ipcRenderer.send('data:flushed'),

  /**
   * Open the native file picker and copy the chosen images into the app's
   * own images folder. Resolves to [{ file, sourceName }].
   */
  pickImages: () => ipcRenderer.invoke('images:pick'),

  /** Remove stored image files that are no longer referenced. */
  deleteImages: (names) => ipcRenderer.invoke('images:delete', names),

  /** Read a stored image as a data: URL, for canvas work that reads pixels. */
  readImage: (name) => ipcRenderer.invoke('images:read', name),

  /**
   * Write an exported ranking image to a path the user picks.
   * Resolves to { saved, filePath?, error? }.
   */
  saveExport: (payload) => ipcRenderer.invoke('export:save', payload),

  /** Open a saved file's folder in the OS file manager. */
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),

  /**
   * Which online catalog backs a library, and whether its credentials are set.
   * Resolves to { supported, provider, ready, missing }.
   */
  catalogStatus: (libraryKey) => ipcRenderer.invoke('catalog:status', libraryKey),

  /**
   * Search the library's online catalog. Resolves to { ok, results } or
   * { ok: false, error } - a lookup failure is reported, never thrown.
   */
  searchCatalog: (libraryKey, query) => ipcRenderer.invoke('catalog:search', libraryKey, query),

  /**
   * Pull one catalog entry in full and download its cover into the app's
   * images folder. Resolves to { ok, entry } where `entry.file` is a stored
   * image name (or null if the cover could not be fetched).
   */
  importFromCatalog: (libraryKey, remoteId) =>
    ipcRenderer.invoke('catalog:import', libraryKey, remoteId),

  /** Build a renderer-safe URL for a stored image file name. */
  imageUrl: (name) => (name ? `gameimg://img/${encodeURIComponent(name)}` : null),

  /** Create a new account. Resolves to { ok, user } or { ok: false, error }. */
  signUp: (email, password) => ipcRenderer.invoke('auth:signUp', { email, password }),

  /** Sign in to an existing account. Resolves to { ok, user } or { ok: false, error }. */
  signIn: (email, password) => ipcRenderer.invoke('auth:signIn', { email, password }),

  /** Sign out. Purely a cloud session change - local data is never touched. */
  signOut: () => ipcRenderer.invoke('auth:signOut'),

  /** The currently signed-in user, or null. Checked once on startup. */
  getCurrentUser: () => ipcRenderer.invoke('auth:getUser'),

  /** Fires whenever the signed-in user changes (sign in, sign out, token refresh). */
  onAuthChange: (callback) => {
    const handler = (_event, user) => callback(user);
    ipcRenderer.on('auth:changed', handler);
    return () => ipcRenderer.removeListener('auth:changed', handler);
  },

  /** Resolves to { ok, profile } or { ok: false, error }. */
  getProfile: () => ipcRenderer.invoke('sync:getProfile'),

  /** Sets the profile-wide default visibility for new/inherited reviews. */
  updateProfile: (defaultVisibility) =>
    ipcRenderer.invoke('sync:updateProfile', { defaultVisibility }),

  /** Upserts one item to the cloud as a review. No-ops server-side if it has no catalog identity. */
  pushReview: (libraryKey, item) => ipcRenderer.invoke('sync:pushReview', libraryKey, item),

  /** Soft-deletes a pushed review so it drops out of everyone's feed. */
  deleteReview: (id) => ipcRenderer.invoke('sync:deleteReview', id),

  /** Your own reviews from the cloud, covers already downloaded. For rebuilding a library on a new machine. */
  pullLibrary: () => ipcRenderer.invoke('sync:pullLibrary'),

  /** Other users' reviews of one catalog item. Resolves to { ok, reviews } or { ok: false, error }. */
  fetchPublicReviews: (provider, providerId) =>
    ipcRenderer.invoke('sync:fetchPublicReviews', provider, providerId),

  /** One user's visible-to-you reviews. Resolves to { ok, displayName, reviews } or { ok: false, error }. */
  fetchProfileReviews: (userId) => ipcRenderer.invoke('sync:fetchProfileReviews', userId),

  /** Fires once a background-downloaded update is ready to install. */
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },

  /** Quit and install the update that's already been downloaded. */
  installUpdate: () => ipcRenderer.invoke('update:install'),
});
