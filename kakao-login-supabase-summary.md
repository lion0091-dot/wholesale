# Kakao Login + Supabase Auth — Implementation Task Brief

## Decision (final, as of now)
Using **Supabase's built-in Kakao OAuth provider** (NOT a custom OIDC provider — that path was abandoned due to a discovery-endpoint 404 when Supabase tried to fetch Kakao's OIDC metadata). This is the confirmed, current approach — do not implement a custom OIDC/OAuth2 provider integration.

## Current Configuration (already done, working)
- **Kakao Developers console**: App configured with `account_email` as a consent item (business-verified or "individual" verified app — email-present accounts already authenticate successfully, confirming this part works).
- **Supabase credentials**: Kakao REST API Key used as Client ID, Kakao Login Client Secret used as Client Secret, entered in Supabase Dashboard → Authentication → Providers → Kakao.
- **Redirect URI**: Synced exactly between Supabase's callback URL and Kakao Developers console's Kakao Login → Redirect URI setting.
- **Supabase Email/Password provider**: Left enabled — this is independent of Kakao social login and used separately for standard email/password auth. Not related to the Kakao email issue.
- **"Allow users without an email" setting**: Already **enabled** in Supabase Dashboard → Authentication → Providers → Kakao. This is the official Supabase setting (added ~July 2026) that allows OAuth sign-in to succeed even when Kakao returns no `account_email` for a user.

## Verified Behavior So Far
- Kakao accounts **with an email**: sign in and account creation via `signInWithOAuth({ provider: 'kakao' })` works correctly.
- Kakao accounts **without an email** (phone-only accounts, or accounts using KakaoTalk's fast/"3-second" in-app login that returns no email): behavior with "Allow users without an email" enabled has **not yet been end-to-end verified with a real no-email test account** — this is the next step.

## Remaining Implementation Task (what to build now)
The login flow needs to be updated/verified to correctly handle **Supabase Kakao users who have no email on `auth.users`** (i.e., `user.email` may be `null` or absent). Specifically:

1. **Do not assume `user.email` exists anywhere in the app.** Any code path that reads `session.user.email` / `user.email` (e.g., displaying it in a profile page, using it as a lookup key, sending welcome emails, etc.) must handle `null`/`undefined` gracefully.
2. **Use `user.id` (Supabase's own UUID) or the Kakao provider's `sub`/`id` (available via `identities` on the Supabase user object) as the real unique identifier** for app-level logic — not email.
3. **Profile data**: nickname, profile image, etc. should come from the Kakao provider payload (`user.user_metadata` — check exactly what Supabase populates for the Kakao provider, e.g. `nickname`, `avatar_url`) and be stored in the app's own `profiles` table keyed by `user.id`, not by email.
4. **If the app has any UI or logic assuming every user has an email** (e.g., "enter email to continue", account recovery via email, notification preferences), add a code path for email-less accounts — e.g., prompt the user to optionally add a real contact email post-signup, stored separately from `auth.users.email`.
5. **End-to-end test**: sign in with a real Kakao test account that has no email registered (phone-only account) and confirm: (a) sign-in succeeds without error, (b) a Supabase `auth.users` row is created correctly with no email or a Supabase-generated placeholder, (c) the app's profile/session logic doesn't break anywhere `user.email` is referenced.

## Explicitly NOT the current direction (do not implement)
- Custom OIDC/OAuth2 provider registration for Kakao in Supabase — abandoned due to discovery 404.
- Synthetic/dummy email generation via the Supabase Admin API (`kakao_{id}@domain.invalid` pattern) — this was an earlier fallback idea, superseded by the built-in provider's "Allow users without an email" setting. Do not build this unless the built-in provider approach is found to fail in end-to-end testing.
