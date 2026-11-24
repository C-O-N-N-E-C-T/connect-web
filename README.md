# connect-web

Web-based coordination dashboard for **CONNECT**, an offline-first earthquake search-and-rescue system.
Coordinators and administrators sign in here to review consolidated field data.

> Field rescuers use the Android app and never sign in to this dashboard.

## Stack

- React 19 + TypeScript
- Vite (dev server and build)
- React Router
- Supabase JS client (authentication)
- Vitest + Testing Library (tests)

## Prerequisites

- Node.js 24 or newer (the backend pins 26 in `connect-backend/.nvmrc`)
- npm
- A running `connect-backend` (see its README) for the API, and access to the project's Supabase project

## Getting started

```bash
npm install
cp .env.example .env     # then fill in the values (see below)
npm run dev              # http://localhost:5173
```

`npm run dev` must use port **5173**. The backend's `CORS_ORIGIN` allows only `http://localhost:5173` locally.

### Local ports

| Service | URL | Notes |
| --- | --- | --- |
| Web dashboard (this repo) | `http://localhost:5173` | Fixed port, required by backend CORS |
| Backend API (`connect-backend`) | `http://localhost:3000` | Set by `PORT` in the backend `.env` |

Start the backend first. Login calls `POST /api/v1/auth/session` on the backend in the default `real` mode, so the backend must be running for sign-in to complete.

The session check uses `GET /api/v1/auth/me`, which is added by the backend branch `OSP-70`. That branch must be merged/deployed for the check to work. Without it the endpoint answers 404, which the app treats as a plain error (no sign-out), so the dashboard still works but revocations are only noticed through other API calls.

## Environment variables

Create `.env` from `.env.example`. Vite only exposes variables prefixed with `VITE_`.

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL. Same value as `SUPABASE_URL` in the backend `.env`. |
| `VITE_SUPABASE_ANON_KEY` | Supabase **anon** key. Same as `SUPABASE_ANON_KEY` in the backend `.env`. |
| `VITE_API_BASE_URL` | Backend base URL. Local: `http://localhost:3000`. |
| `VITE_AUTH_SESSION_MODE` | `mock` or `real`. See "Auth session mode" below. |

Rules:

- **Never** put `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, or any seed password in this repo or in `.env`. Anything prefixed `VITE_` is bundled into the JavaScript that every browser downloads.
- `.env` is git-ignored. Do not commit it, and do not paste it into issues, PRs, or chat.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite dev server on port 5173. |
| `npm run build` | Type-checks, then produces a production build in `dist/`. |
| `npm run typecheck` | Type-checks only. |
| `npm test` | Runs the test suite once. |
| `npm run preview` | Serves the production build locally. |

## Auth session mode

Login uses Supabase directly (`signInWithPassword`). After a successful login the app also registers the browser session with the backend (`POST /api/v1/auth/session`, OSP-60).

- `VITE_AUTH_SESSION_MODE=real` (default in `.env.example`): calls the backend. The contract is documented in `connect-backend/docs/osp-60-auth-session.md`. Success returns 200 with `{ user_id, role, device_id }`. Errors use `{ error_code, message }`: `ACCOUNT_DISABLED` and `DEVICE_REVOKED` return 403, `RATE_LIMITED` returns 429.
- `VITE_AUTH_SESSION_MODE=mock`: skips the backend calls and treats registration as successful. `GET /api/v1/auth/me` and `POST /api/v1/auth/logout` are skipped too. Use only for offline UI work without the backend.

Restart `npm run dev` after changing `.env`. Vite reads environment variables only at startup.

## Accounts and roles

Web accounts are pre-provisioned. There is no self sign-up.

| Role | Web access |
| --- | --- |
| `coordinator` | Main coordination dashboard (`/dashboard`) |
| `administrator` | Administration area (`/admin`) |
| `rescuer` | **Not allowed.** Login is rejected and the session is signed out. |

The role comes from the `user_role` claim in the access token, which the Supabase Custom Access Token Hook sets from `public.user_profiles.role`. Accounts without a profile row, or with `is_active = false`, are treated as not allowed.

The route guard only hides screens. Authorization is enforced by the backend on every API call.

To create test accounts, see the backend README (`npm run seed`) or the Supabase setup notes in `connect-backend/docs/supabase-settings.md`.

## Login behaviour

| Situation | Message shown |
| --- | --- |
| Wrong email or password (HTTP 4xx from Supabase) | "E-posta veya şifre hatalı." |
| No connection to Supabase | "Bağlantı kurulamadı…" |
| Rescuer account | "Saha kurtarıcı hesapları web panelinden giriş yapamaz." |
| `ACCOUNT_DISABLED`, `DEVICE_REVOKED`, `RATE_LIMITED` from the backend | Specific message per code |

After a forced sign-out (see "API client" below) the login page shows why the session ended. The reason is passed in `sessionStorage` (`connect.signout_reason`), shown once and then cleared.

| Reason | Message |
| --- | --- |
| `DEVICE_REVOKED` | "Bu cihazın erişimi iptal edildi." |
| `ACCOUNT_DISABLED` | "Hesabınız devre dışı bırakıldı. Yöneticinize başvurun." |
| `SESSION_NOT_BOUND` | "Oturum cihaza bağlanamadı. Tekrar giriş yapın." |
| `ROLE_NOT_ALLOWED` | "Saha kurtarıcı hesapları web panelinden giriş yapamaz." |
| `SESSION_EXPIRED` | "Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın." |

The login form validates the email format and that the password is not empty before submitting. The password field has a show/hide toggle.

## Session handling (OSP-70)

### AuthProvider

`src/auth/AuthProvider.tsx` holds the session and role for the whole app. Components read them with `useAuth()` (`status`: `loading` | `signedIn` | `signedOut`, `session`, `role`, `logout()`).

- On start it reads the stored Supabase session (`getSession()`), so the session and role survive a page reload. It then subscribes to `onAuthStateChange` (sign-in, token refresh, sign-out in another tab). The callback only updates state; it never awaits a Supabase call (known supabase-js deadlock).
- **Supabase unreachable at start (R4).** If the stored token has to be refreshed while Supabase cannot be reached (offline, 5xx), supabase-js keeps the session but cannot return it. The app does not treat this as "signed out": it stays in `loading` with "Sunucuya ulaşılamıyor. Yeniden deneniyor…" (no panel, no `/login`), and reads the session again after 2, 5 and 10 s, then every 30 s. A `TOKEN_REFRESHED` from supabase-js also ends the wait. Because of the SDK's 60 s refresh-failure cooldown (see below), the wait can last about a minute after the network returns. The same rule applies to the back/forward-cache re-check: a transient failure keeps the current state.
- The role starts as the JWT `user_role` claim. `GET /api/v1/auth/me` then returns the role from the database, and **the server role wins**. A non-web role (`rescuer`) is signed out with `ROLE_NOT_ALLOWED`.
- `GET /api/v1/auth/me` runs once on start (when there is a session) and again when the tab becomes visible (`visibilitychange`). There is no polling. A check already in flight is reused, and a visibility check is skipped if the last one started less than 10 s ago. It is not called on `/login`, neither at start nor on visibility, because a sign-in may be in progress there (R12). An answer is applied only to the session and user that asked (R2).
- The panel renders with the JWT role right away. It does not wait for `/auth/me`, and corrects the role (or signs out) when the answer arrives.
- Why `/auth/me` and not an existing endpoint: the panels make no backend calls yet, so a revoked device would otherwise only be noticed later. `GET /api/v1/victims` writes an audit row on every call (OSP-65) and downloads sensitive data, so it is not used as a ping.
- `RequireRole` uses `useAuth()`. It shows "Yükleniyor…" while the status is `loading`, and still re-checks the session when a page is restored from the back/forward cache.

### API client

Backend calls go through `apiClient.request(path, options)` (`src/services/apiClient.ts`, wired in `src/auth/authRuntime.ts`). It adds `Authorization: Bearer <access_token>`, accepts only paths that start with a single `/` and contain no `\` (so the token is only sent to `VITE_API_BASE_URL`), has one time budget per request (15 s by default) that covers reading the session, the request, any refresh or re-bind, and the retries (when it runs out the result is `TIMEOUT`, without sign-out), and returns a typed result (`{ ok: true, data }` or `{ ok: false, error: { kind, status?, errorCode?, reason? } }`). It never throws for HTTP or network errors.

| Response | What the client does |
| --- | --- |
| 401 | One shared session refresh, then a retry. Supabase rejects the refresh token (4xx, `session_not_found`) or there is no session to refresh: forced sign-out (`SESSION_EXPIRED`). The refresh fails for a transient reason (network, 5xx, 429, timeout): typed error, **no sign-out**. |
| 403 `DEVICE_REVOKED` / `ACCOUNT_DISABLED` | Forced sign-out with that reason. |
| 403 `SESSION_NOT_BOUND` | One shared `POST /api/v1/auth/session` (re-bind) for the same session, then a retry. Re-bind refused with `DEVICE_REVOKED` / `ACCOUNT_DISABLED`: forced sign-out with that reason. Re-bind answered 401: forced sign-out (`SESSION_EXPIRED`). Any other re-bind failure (network, 429, 5xx, timeout, other error): typed error, **no sign-out**. |
| 403 `ROLE_FORBIDDEN` | Typed error `ROLE_FORBIDDEN`, no sign-out. Show `ROLE_FORBIDDEN_MESSAGE` ("Bu işlem için yetkiniz yok."). |
| 429, 5xx, network error, timeout, other | Typed error, no sign-out. |

- **Each recovery kind at most once per request (R9).** A request gets at most one refresh and at most one re-bind, so at most two retries, and no loop. Example: 401, refresh, retry, `SESSION_NOT_BOUND`, re-bind, retry, success. A second 401 is definitive (`SESSION_EXPIRED`), and so is a second `SESSION_NOT_BOUND` (`SESSION_NOT_BOUND`).
- **Sign-out only on a definitive rejection (D4a).** A transient failure while refreshing or re-binding returns a typed error (`NETWORK_ERROR`, `SERVER_ERROR`, `RATE_LIMITED` or `TIMEOUT`) without a retry. Example: the crisis centre's internet drops for 2 s exactly when the token is refreshed, and the coordinator stays signed in.
- **SDK refresh-failure cooldown (R3).** supabase-js caches every failed refresh, transient ones included, for 60 s per refresh token. During that window `refreshSession()`, and `getSession()` with an expiring token, return the cached failure without a network call. After a short outage, requests may therefore keep failing (`NETWORK_ERROR`, `SERVER_ERROR` or `TIMEOUT`) for up to 60 s even though the network is back. Nobody is signed out. This is library behaviour, and the app adds no cache of its own.
- **Bound to the session that sent the request (R2).** Each request remembers its session (the JWT `session_id`). If that session was ended in this tab (logout or forced sign-out), or another session is current (someone else signed in), the client does not refresh, re-bind or sign out, and the result is `SESSION_CHANGED`. A late response can therefore never sign out the next user or replace the login banner. If the session vanished without this tab ending it (supabase-js dropped it), D4a's "no session to refresh" applies: forced sign-out with `SESSION_EXPIRED`.
- **Multi-tab (R7).** After a failed refresh the client reads the session again. If another tab has already rotated it (`refresh_token_already_used`, or a refresh discarded because storage changed), the newer token of the same session is used.
- Concurrent 401s of the same session share one refresh, and concurrent `SESSION_NOT_BOUND` responses share one re-bind. Each refresh or re-bind attempt is limited to 10 s (R8), and a re-bind is aborted at that point. A hung attempt therefore cannot block later requests: the next request starts a new re-bind. For a refresh it calls the SDK again, but supabase-js may still be waiting on its own refresh request.
- A transient failure while reading the session (supabase-js could not refresh an expiring token) returns `NETWORK_ERROR`, `SERVER_ERROR`, `RATE_LIMITED` or `TIMEOUT`, not `UNAUTHENTICATED` (R10). `UNAUTHENTICATED` means there is no session.
- A **forced sign-out** stores the reason for `/login`, signs out with `scope: 'local'`, and navigates to `/login`. Concurrent forced sign-outs produce one navigation and one message. It never calls `/auth/logout`, because the backend has already rejected the token.
- `recovery: false` turns off refresh, re-bind, retry and forced sign-out. Logout uses it. All of these are also off for every request of the session whose logout is pending.

### Logout

The "Çıkış yap" button (`AppLayout`) runs this flow:

1. The button is disabled and shows "Çıkış yapılıyor…". Extra clicks are ignored.
2. `localStorage['connect.logout_pending'] = <session_id>` is written **before** any network call. The value identifies the session being logged out.
3. `POST /api/v1/auth/logout` runs with a 5 s timeout and recovery turned off. The flow continues whatever the outcome (network error, 5xx, 401, 403, 429, timeout).
4. `supabase.auth.signOut({ scope: 'local' })`, limited to 3 s (see below).
5. The flag is removed and the app navigates to `/login`.

If the browser is closed or reloaded during step 3, the flag survives. On the next start, `AuthProvider` finishes the logout before showing anything: it tries `/auth/logout` once more with a 3 s timeout, signs out locally (again limited to 3 s), removes the flag and goes to `/login`. No protected screen is rendered meanwhile.

The flag only ever applies to the session it names (R6). A new sign-in (a different `session_id`) clears it at once, so the new user is shown normally and a later reload does not log them out. A late finish of the old logout never signs out the new session. At startup, a flag naming an older session than the one stored is discarded.

Every sign-out in the web app uses `scope: 'local'`. With the default `global` scope, a network or 5xx failure keeps the local session, so the user silently stays signed in. `global` would also end the user's sessions on other devices.

`signOut({ scope: 'local' })` is not network-free. When the stored token expires within 90 s, supabase-js first refreshes it, retrying with no fetch timeout, and only then removes the session. It then waits for Supabase `POST /logout`, also with no timeout. Every sign-out (the logout button, an interrupted logout at startup, a forced sign-out) therefore waits at most 3 s. If `signOut` has not finished by then, or the same session is still stored afterwards, the app removes the persisted Supabase session itself (`sb-<project>-auth-token`, set explicitly in `src/lib/supabase.ts` to the supabase-js default) and the app treats the user as signed out. A session that another sign-in stored meanwhile is never removed. The worst-case logout is therefore about 5 s (`/auth/logout`) plus 3 s.

### Known limits

- The `connect.logout_pending` flag is **not** a security control. Someone who controls the browser can block `/auth/logout`, delete the flag or copy the token, but they only keep their own session, which they could also do by not pressing logout. Enforcement happens on the server: the OSP-61 guard checks every request (`DEVICE_REVOKED` / `ACCOUNT_DISABLED`), access tokens expire (~1 h), and refresh tokens can be revoked.
- The `LOGOUT` audit row is written only when the client reaches `/auth/logout`, so it can be suppressed.
- If `/auth/logout` did not succeed, a copied access token stays usable at the backend until it expires.
- A revoked device is noticed on the next backend call: on start, when the tab becomes visible again, or on any later API call. There is no polling.
- `/api/v1/auth/*` is rate-limited to 10 requests per minute per IP, but the backend exempts `GET /api/v1/auth/me` (team decision, backend branch `OSP-70`), so visibility checks do not use up the login/logout budget of users behind the same NAT. Rebind (`POST /auth/session`) and logout still count. A 429 is a typed error and does not sign the user out.

## Project structure

```
src/
  App.tsx                  routes
  main.tsx                 entry point, imports styles.css
  styles.css               all styles (single stylesheet)
  auth/
    AuthProvider.tsx       session + role state, useAuth(), /auth/me check, interrupted-logout recovery
    authRuntime.ts         app wiring: Supabase, API client, forced sign-out
    forcedSignOut.ts       forced sign-out (reason for /login, local sign-out, navigation)
    logout.ts              logout flow with the pending flag
    login.ts               login flow (dependency-injected, unit tested)
    RequireRole.tsx        route guard by role
  components/
    AppLayout.tsx          shared shell for panel pages (includes disclaimer)
    SupplementaryDisclaimer.tsx   required safety notice (NFR-SAFE-03)
    SeismographBackground.tsx     decorative login background
    BrandMark.tsx, icons.tsx
  lib/
    supabase.ts            Supabase client (anon key only)
    jwt.ts                 reads claims from the token (no signature check, UI only)
    roles.ts               web roles and routing
  pages/
    LoginPage.tsx
    CoordinatorDashboard.tsx   placeholder
    AdminPage.tsx              placeholder
  services/
    apiClient.ts           backend API client with unified 401/403 handling
    authSessionClient.ts   backend session registration (mock or real)
    deviceId.ts            per-browser device id in localStorage
```

## Testing

```bash
npm test
```

Tests cover the login flow and error mapping, role routing, JWT claim reading, the session client, the API client error table, forced sign-out, the AuthProvider (reload, `/auth/me`, interrupted logout), the logout flow, the revocation scenario (AC-19), and the login and panel screens. Tests use a fixed test environment defined in `vite.config.ts`, so they do not need a real `.env`.

## Conventions

- **Language:** UI text is Turkish. Code, comments, and this README are English.
- **Accessibility:** The SOW requires WCAG for the web dashboard. Keep visible labels on inputs, associate error messages with fields, keep contrast at AA or better, and keep keyboard focus visible.
- **Required disclaimer:** `SupplementaryDisclaimer` must appear on every login and panel view (NFR-SAFE-03 / AC-29). Use `AppLayout` for panel pages so it is never left out.
- **Medical fields:** Self-reported blood type and medical fields must carry the label "self-reported, unverified — do not use for transfusion without cross-matching" (NFR-SAFE-03). Apply this to any screen that shows them.

## Current status

- Login, role-based routing, and the rescuer rejection are implemented.
- Backend session registration uses the OSP-60 endpoint (`real` mode by default).
- Session handling (AuthProvider, API client, logout with `/auth/logout`) is implemented (OSP-70). `GET /api/v1/auth/me` needs the backend `OSP-70` branch.
- Panels are placeholders. Map, records, and admin features come in later tickets.
