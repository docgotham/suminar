# Suminar auth email templates

Suminar sends its transactional auth mail through **Supabase Auth → custom SMTP
→ Resend** (see `C:\Users\Dave\dm_sum\docs\resend-smtp-cutover.md` for the
carrier setup, which is identical here). GoTrue renders these templates and
hands them to Resend; there is no custom email-sending code in this repo.

Paste each body into **Supabase dashboard → Authentication → Emails →
Templates**, pick the matching template on the left, and set the **Subject**
shown here.

---

## 1. Reset Password — REQUIRED

This is the only template the password-reset flow depends on, and it **must** be
customized: the default template points at Supabase's hosted verify URL (an
implicit-flow link that needs client-side JS), whereas Suminar's reset page
consumes a `token_hash` server-side. The link below carries that token_hash to
`/account/reset`, which POSTs it to `/api/account/reset` — no redirect-allowlist
entry and no Supabase JS required.

**Subject:** `Reset your Suminar password`

```html
<h2 style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-weight:700;">Reset your Suminar password</h2>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-size:15px;line-height:1.55;">
  We received a request to reset the password for this Suminar account.
  Choose a new one with the link below — it works once and expires shortly.
</p>
<p style="margin:24px 0;">
  <a href="https://suminar.ai/account/reset?token_hash={{ .TokenHash }}&type=recovery"
     style="font-family:'Segoe UI',system-ui,sans-serif;font-weight:600;font-size:15px;background:#2b46c8;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;">
    Reset your password
  </a>
</p>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#5c6070;font-size:13px;line-height:1.55;">
  If you didn't ask for this, you can ignore this email — your password stays
  exactly as it is.
</p>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#5c6070;font-size:13px;">— Sum·inar</p>
```

> The domain is hardcoded to `https://suminar.ai` on purpose: auth mail only
> ever fires from production, so the link should always land on prod regardless
> of which deploy triggered the send. (If you prefer, and **Site URL** under
> Authentication → URL Configuration is set to `https://suminar.ai`, you may
> swap the literal for `{{ .SiteURL }}`.)

---

## 2. Confirm signup — optional

Suminar's self-serve signup auto-confirms the email (`email_confirm: true`), so
this template does **not** currently fire. Branded here only so it's on-voice if
a future flow ever turns email confirmation on.

**Subject:** `Confirm your Suminar email`

```html
<h2 style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-weight:700;">Confirm your email</h2>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-size:15px;line-height:1.55;">
  Welcome to Suminar. Confirm this address to finish setting up your account.
</p>
<p style="margin:24px 0;">
  <a href="{{ .ConfirmationURL }}"
     style="font-family:'Segoe UI',system-ui,sans-serif;font-weight:600;font-size:15px;background:#2b46c8;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;">
    Confirm email
  </a>
</p>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#5c6070;font-size:13px;">— Sum·inar</p>
```

---

## 3. Magic Link — optional

Not currently used (Suminar signs in with a password or a connector token).
Branded for completeness.

**Subject:** `Your Suminar sign-in link`

```html
<h2 style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-weight:700;">Your sign-in link</h2>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#10142a;font-size:15px;line-height:1.55;">
  Use the link below to sign in to Suminar. It works once and expires shortly.
</p>
<p style="margin:24px 0;">
  <a href="{{ .ConfirmationURL }}"
     style="font-family:'Segoe UI',system-ui,sans-serif;font-weight:600;font-size:15px;background:#2b46c8;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;">
    Sign in to Suminar
  </a>
</p>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#5c6070;font-size:13px;line-height:1.55;">
  If you didn't try to sign in, you can ignore this email.
</p>
<p style="font-family:'Segoe UI',system-ui,sans-serif;color:#5c6070;font-size:13px;">— Sum·inar</p>
```

---

## SMTP settings reminder (Supabase → Authentication → Emails → SMTP Settings)

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | *your Resend API key* — you paste it; it never goes through the repo |
| Sender email | `noreply@suminar.ai` (after the domain verifies in Resend) |
| Sender name | `Suminar` |

Custom SMTP also raises GoTrue's built-in email rate limit (the default 2/hour
is what locked you out of your own reset before) — set it generously under
Authentication → Rate Limits once SMTP is on.
