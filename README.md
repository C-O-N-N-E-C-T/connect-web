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
- `VITE_AUTH_SESSION_MODE=mock`: skips the backend call and treats registration as successful. Use only for offline UI work without the backend.

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

The login form validates the email format and that the password is not empty before submitting. The password field has a show/hide toggle.

## Project structure

```
src/
  App.tsx                  routes
  main.tsx                 entry point, imports styles.css
  styles.css               all styles (single stylesheet)
  auth/
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
    authSessionClient.ts   backend session registration (mock or real)
    deviceId.ts            per-browser device id in localStorage
```

## Testing

```bash
npm test
```

Tests cover the login flow and error mapping, role routing, JWT claim reading, the session client, and the login and panel screens. Tests use a fixed test environment defined in `vite.config.ts`, so they do not need a real `.env`.

## Conventions

- **Language:** UI text is Turkish. Code, comments, and this README are English.
- **Accessibility:** The SOW requires WCAG for the web dashboard. Keep visible labels on inputs, associate error messages with fields, keep contrast at AA or better, and keep keyboard focus visible.
- **Required disclaimer:** `SupplementaryDisclaimer` must appear on every login and panel view (NFR-SAFE-03 / AC-29). Use `AppLayout` for panel pages so it is never left out.
- **Medical fields:** Self-reported blood type and medical fields must carry the label "self-reported, unverified — do not use for transfusion without cross-matching" (NFR-SAFE-03). Apply this to any screen that shows them.

## Current status

- Login, role-based routing, and the rescuer rejection are implemented.
- Backend session registration uses the OSP-60 endpoint (`real` mode by default).
- Panels are placeholders. Map, records, and admin features come in later tickets.
