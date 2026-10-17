/**
 * Buying the developer a coffee.
 *
 * One page, one link, and a gold ring for whoever follows it. The badge is
 * granted by the Buy Me a Coffee webhook - see supabase/functions/bmc-webhook
 * - and matched on the email the donation was paid with. Nothing in this file
 * decides who has one; it only knows where the button goes.
 *
 * The ring is the entire reward, on purpose. A donation that unlocks a
 * feature is a purchase, and a purchase comes with expectations, refunds and
 * terms that a hobby app has no business taking on.
 */

/**
 * Replace `yourname` with the page you registered at buymeacoffee.com.
 *
 * The host has to stay one of the two in EXTERNAL_HOSTS in electron/main.js -
 * the main process refuses to open anything else, which is what stops this
 * constant from being a way to open arbitrary URLs if it is ever edited
 * carelessly.
 */
export const SUPPORT_URL = 'https://buymeacoffee.com/yourname';

/** True once the placeholder above has actually been filled in. */
export const SUPPORT_CONFIGURED = !SUPPORT_URL.endsWith('/yourname');

/**
 * Hand the link to the OS browser. Never opens anything in-app: a payment
 * page inside an Electron window is both worse to use and impossible for
 * anyone to verify the address of.
 */
export function openSupportPage() {
  return window.api.openExternal(SUPPORT_URL);
}
