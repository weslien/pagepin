# RP-initiated logout verification

This file documents the manual verification steps for the OIDC RP-initiated logout flow against an authentik instance.

## Prerequisites

- A running pagepin instance with `PAGEPIN_AUTH_MODE=oidc`
- An authentik provider registered with:
  - **Redirect URI**: `https://<pagepin-console>/auth/callback`
  - **Post-logout redirect URI**: `https://<pagepin-console>/auth/logout/done`

## Steps

1. Log in through the console.
2. After login, open browser DevTools and verify the `pp_id_token` cookie exists (httpOnly, host-only).
3. Click **Sign out** in the console top bar.
4. Verify the browser is redirected to the authentik end-session endpoint with these query parameters:
   - `id_token_hint` — the value of the `pp_id_token` cookie
   - `client_id` — the value of `PAGEPIN_OIDC_CLIENT_ID`
   - `post_logout_redirect_uri` — `https://<pagepin-console>/auth/logout/done`
5. After authentik clears its session, verify it redirects the browser to the `post_logout_redirect_uri` above.
6. On the `/auth/logout/done` page, verify:
   - The page shows **"Signed out"**.
   - No `pp_session`, `pp_csrf`, or `pp_id_token` cookies remain in browser storage.
7. Navigate back to the console root. Verify you are anonymous (login wall or login button shown).

## Expected result

- The pagepin local session ends before the IdP redirect.
- The authentik SSO session ends because the browser visits the end-session URL.
- The user lands on the post-logout page with no stale auth state.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| Logout stays on `/` instead of going to authentik | No `pp_id_token` cookie (social login or pre-fix session). This is the intended fallback. |
| Authentik shows an error about the redirect URI | The `post_logout_redirect_uri` is not registered in the authentik provider. Add `https://<host>/auth/logout/done`. |
| Back button restores the session | The browser cached the page. Check cookies in DevTools; `pp_session` must be empty. |
