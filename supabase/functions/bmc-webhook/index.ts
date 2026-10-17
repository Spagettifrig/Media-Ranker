/**
 * Buy Me a Coffee webhook - the only thing that can make someone a supporter.
 *
 * Buy Me a Coffee POSTs here when a donation lands. This verifies that the
 * POST really came from them, pulls the donor's email out of it, and hands
 * that to record_support() in the database. Nothing else writes to
 * public.supporters, and no client can - see the header of
 * supabase/supporters.sql for why the badge is not a column on profiles.
 *
 * Two things make this safe to expose without the platform's JWT check
 * (which has to be off - Buy Me a Coffee does not carry our anon key):
 *
 *   1. The HMAC below. An unsigned or wrongly signed POST is refused before
 *      anything is read out of it, so "anyone can call this URL" is true and
 *      also useless.
 *   2. The event id. Every event is recorded once; a replayed body - even a
 *      correctly signed one captured off the wire - is a no-op.
 *
 * Deploying it (see README.md in this folder for the full walk):
 *
 *   supabase secrets set --project-ref njxypnkamladkjtxging BMC_WEBHOOK_SECRET=...
 *   supabase functions deploy bmc-webhook --project-ref njxypnkamladkjtxging --no-verify-jwt
 *
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
 * The service role key must never be copied anywhere else - it bypasses Row
 * Level Security entirely, which is precisely why it lives only here.
 */

/**
 * Buy Me a Coffee signs the raw body with this header. The name has moved
 * between casings over the years and Deno lowercases them all anyway, so the
 * lookup is a list rather than a constant.
 */
const SIGNATURE_HEADERS = ['x-signature-sha256', 'x-signature', 'x-bmc-signature'];

/** Anything larger than this is not a webhook, and is not worth hashing. */
const MAX_BODY = 64 * 1024;

/**
 * Event types worth acting on. Everything else - a membership update, a
 * profile change - is acknowledged and ignored, because answering anything
 * but 200 to a well-formed event just earns a retry of something we were
 * never going to record.
 */
const PAID = new Set([
  'donation.created',
  'membership.started',
  'membership.updated',
  'extra_purchase.created',
]);

const REFUNDED = new Set([
  'donation.refunded',
  'membership.cancelled',
  'extra_purchase.refunded',
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set on this project.`);
  return value;
}

/* ------------------------------------------------------------------ *
 * Signature
 * ------------------------------------------------------------------ */

/**
 * Constant-time compare. A plain `===` on a hex digest leaks, through how
 * long it takes to fail, how many leading characters a guess got right -
 * which is enough to walk a forged signature character by character.
 */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function signatureMatches(rawBody: string, provided: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env('BMC_WEBHOOK_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  // Some senders prefix the digest with the algorithm ("sha256=abc123").
  const cleaned = provided.trim().replace(/^sha256=/i, '').toLowerCase();
  return sameDigest(toHex(signed), cleaned);
}

/* ------------------------------------------------------------------ *
 * Reading the payload
 *
 * Deliberately forgiving about *where* each field sits. The three event
 * families do not agree on their own shape - a donation has
 * `supporter_email`, a membership has `payer_email` - and the shapes have
 * changed before. Guessing wide costs nothing; guessing narrow means a
 * donation silently not counting, which is the one outcome worth avoiding.
 * ------------------------------------------------------------------ */

type Payload = Record<string, unknown>;

function pick(payload: Payload, data: Payload, keys: string[]): unknown {
  for (const key of keys) {
    if (data[key] != null && data[key] !== '') return data[key];
    if (payload[key] != null && payload[key] !== '') return payload[key];
  }
  return null;
}

function donorEmail(payload: Payload, data: Payload): string | null {
  const found = pick(payload, data, [
    'supporter_email',
    'payer_email',
    'email',
    'buyer_email',
    'supporter_email_address',
  ]);
  const email = typeof found === 'string' ? found.trim().toLowerCase() : '';
  // Not validation for its own sake: an address with no @ cannot ever match
  // an auth.users row, so recording it would only ever be dead weight.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/** Whole-currency amount to minor units, tolerating "5", 5, and "5.00". */
function minorUnits(payload: Payload, data: Payload): number {
  const found = pick(payload, data, ['total_amount_charged', 'amount', 'total', 'price']);
  const amount = typeof found === 'string' ? Number.parseFloat(found) : Number(found);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
}

function eventId(payload: Payload, data: Payload): string {
  const found = pick(payload, data, ['event_id', 'id', 'transaction_id']);
  if (found != null && String(found).trim() !== '') return String(found).trim();
  // No id at all: fall back to a digest of the body's own identifying bits, so
  // a retry of *this* event still dedupes even though the sender gave us
  // nothing to dedupe on.
  return `bmc:${JSON.stringify({ t: payload.type, c: payload.created, d: data.created_at })}`;
}

function eventTime(payload: Payload, data: Payload): string {
  const found = pick(payload, data, ['created_at', 'created', 'paid_at']);
  if (typeof found === 'string') {
    const parsed = new Date(found);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  if (typeof found === 'number') {
    // Unix seconds, which is how `created` arrives.
    const parsed = new Date(found * 1000);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ *
 * The one database call this function knows how to make
 * ------------------------------------------------------------------ */
async function recordSupport(args: {
  email: string;
  minor: number;
  at: string;
  eventId: string;
  refund: boolean;
}): Promise<string> {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/record_support`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_email: args.email,
      p_minor: args.minor,
      p_at: args.at,
      p_event_id: args.eventId,
      p_refund: args.refund,
    }),
  });

  if (!response.ok) {
    throw new Error(`record_support failed (${response.status}): ${await response.text()}`);
  }
  return String(await response.json());
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */
Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405);

  const signature = SIGNATURE_HEADERS.map((name) => request.headers.get(name)).find(Boolean);
  if (!signature) return json({ error: 'Unsigned.' }, 401);

  // Read the body as text, not JSON: the signature covers the exact bytes
  // sent, and re-serialising parsed JSON would not reproduce them.
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) return json({ error: 'Too large.' }, 413);

  try {
    if (!(await signatureMatches(rawBody, signature))) {
      // Deliberately says nothing about why. A verbose rejection is a hint.
      console.warn('[bmc-webhook] rejected a POST with a bad signature');
      return json({ error: 'Bad signature.' }, 401);
    }
  } catch (err) {
    console.error('[bmc-webhook] could not verify:', err);
    return json({ error: 'Misconfigured.' }, 503);
  }

  let payload: Payload;
  try {
    payload = JSON.parse(rawBody) as Payload;
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const type = String(payload?.type ?? '');
  const data = (payload?.data ?? {}) as Payload;
  const refund = REFUNDED.has(type);
  if (!refund && !PAID.has(type)) {
    // Acknowledged and dropped. See PAID above for why this is a 200.
    console.log(`[bmc-webhook] ignoring ${type || '(no type)'}`);
    return json({ ok: true, ignored: type });
  }

  const email = donorEmail(payload, data);
  if (!email) {
    // Nothing to attach the badge to. Logged in full so it can be granted by
    // hand from the SQL editor - see grant_support() in supporters.sql.
    console.error('[bmc-webhook] no usable email on this event:', rawBody);
    return json({ ok: true, ignored: 'no-email' });
  }

  try {
    const outcome = await recordSupport({
      email,
      minor: minorUnits(payload, data),
      at: eventTime(payload, data),
      eventId: eventId(payload, data),
      refund,
    });
    // The email is not logged: function logs are a second place it would then
    // live, and the whole point of supporters.sql is that it lives in one.
    console.log(`[bmc-webhook] ${type} -> ${outcome}`);
    return json({ ok: true, outcome });
  } catch (err) {
    // A 5xx here is on purpose: it is what asks Buy Me a Coffee to retry,
    // which is exactly what should happen if the database was briefly down.
    console.error('[bmc-webhook]', err);
    return json({ error: 'Could not record that.' }, 503);
  }
});
