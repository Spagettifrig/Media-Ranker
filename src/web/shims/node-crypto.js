/** electron/steam.js only needs randomUUID, which every browser now has. */
export const randomUUID = () => globalThis.crypto.randomUUID();
export default { randomUUID };
