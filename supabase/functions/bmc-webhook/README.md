# Buy Me a Coffee webhook

Turns a donation into a supporter badge. Buy Me a Coffee POSTs here, this
function checks the signature, and the donor's email goes into
`public.supporters` — a table nothing else on earth can write to.

The service role key it uses is injected by Supabase and stays inside the
function. Nothing secret goes into the installer, same as the catalog proxy.

## Before any of this: run the SQL

`supabase/supporters.sql`, in the Supabase SQL editor, once. The function
calls `record_support()` from that file and will fail without it.

## One-time setup

You need the Supabase CLI. On Windows the reliable way to reach it is `npx`,
which downloads it on first use and needs no install:

```bash
npx supabase@latest login
```

### 1. Create the Buy Me a Coffee page

buymeacoffee.com → sign up. The page name you pick becomes your URL, e.g.
`buymeacoffee.com/yourname`. Payouts need a Stripe or PayPal connection and
their identity check, which is between you and them — the app does not care
whether that is finished, only that the page exists.

Put that URL into `src/lib/support.js`. It is the one place it appears.

### 2. Deploy the function

Run from the repo root. The `--no-verify-jwt` is required and not optional:
Buy Me a Coffee has no idea what a Supabase anon key is, so the platform's
own JWT gate has to be off and the HMAC signature check inside the function
is what replaces it.

```bash
npx supabase@latest functions deploy bmc-webhook --project-ref njxypnkamladkjtxging --no-verify-jwt
```

The URL it prints is what Buy Me a Coffee needs:

```
https://njxypnkamladkjtxging.supabase.co/functions/v1/bmc-webhook
```

### 3. Register the webhook and store its secret

Buy Me a Coffee → Dashboard → Settings → Webhooks → add that URL. It shows
you a signing secret once. Copy it straight into the command below — do not
paste it into a chat, a commit, or a file.

```bash
npx supabase@latest secrets set --project-ref njxypnkamladkjtxging BMC_WEBHOOK_SECRET=paste-it-here
```

Takes effect on the next cold start. No redeploy needed.

## Checking it works

Buy Me a Coffee's webhook page has a "send test event" button. Send one, then
look at the function logs in the Supabase dashboard:

| Log line | What happened |
| --- | --- |
| `donation.created -> recorded` | Worked. The badge is live. |
| `donation.created -> duplicate` | Already counted. A retry, which is correct. |
| `rejected a POST with a bad signature` | The secret does not match. Re-run step 3. |
| `no usable email on this event` | See "when the email does not match" below. |
| `Misconfigured` | `BMC_WEBHOOK_SECRET` is not set on the project. |

A test event carrying a real email address grants a real badge. Only you can
fire one, so that is a convenience rather than a hole, but it is worth knowing
before you test with your own address.

## When the email does not match

The badge is matched on email: the address someone paid with has to be the
address they signed into Game Ranker with. Buy Me a Coffee also lets people
donate anonymously, with no usable address at all.

Both cases land in the function logs and neither is lost. Grant it by hand:

```sql
select public.grant_support('them@example.com');
```

Use the address of their **Game Ranker account**, not the one they paid with.
Undo it with `public.revoke_support('them@example.com')`.

There is no in-app "I donated, give me my badge" box on purpose. Anyone who
guessed a donor's address could claim their badge, and a cosmetic ring is not
worth a claim path that can be walked by strangers.

## What a supporter actually gets

A gold ring around their avatar and their name, everywhere other people see
them. Nothing else. No features, no ranking weight, no extra visibility.

That is a deliberate line, not an oversight. The moment a donation buys
functionality it stops being a donation, and both Buy Me a Coffee's terms and
every refund conversation that follows get much harder. Keep it cosmetic.

## Rotating the secret

Change it on the Buy Me a Coffee side, then:

```bash
npx supabase@latest secrets set --project-ref njxypnkamladkjtxging BMC_WEBHOOK_SECRET=the-new-one
```

Donations that arrive in the gap are retried by Buy Me a Coffee for a while,
so a quick rotation loses nothing.

## Switching to Ko-fi or PayPal later

Everything below the signature check is provider-shaped, and everything the
database and the app do is not. Ko-fi posts a form-encoded `data` field with a
verification token instead of an HMAC, so `signatureMatches` and the field
lookups change; `record_support` and `supporter_ids` do not, and neither does
a single line of the desktop app.
