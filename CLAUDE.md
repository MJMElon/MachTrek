# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` too — it is binding.** It carries the detailed invariants (offline-first rules, data-model change checklist, Supabase safety, PWA constraints). This file is the quick orientation layer on top of it; don't duplicate one into the other when updating.

## What this is

An offline-first, mobile-first PWA for recording heavy-machinery piece-rate work, with an admin side for rates/operators/payroll/claim printing. React 18 + Vite 5 (plain JSX, ESM), Tailwind, Dexie (IndexedDB), Supabase (PostgREST + Auth + Storage), `vite-plugin-pwa`. Deployed to GitHub Pages at `https://mjmelon.github.io/MachTrek/` via `.github/workflows/deploy.yml` — **every push to `main` deploys production**. Real operators use the live app daily.

## Commands

```bash
npm run dev       # Vite dev server (http://localhost:5173, LAN URL for phone testing; SW enabled in dev)
npm run build     # production build — the ONLY automated check; run it after every change
npm run preview   # serve the production build
npm run gen-icons # regenerate PWA icons from public/logo.svg
```

There are no test/lint/typecheck scripts. Verification = `npm run build` + manual checks in the browser (offline save, reload persistence, reconnect sync where relevant).

## Working agreements established with this user

- **Never push without an explicit request.** The user tests locally first, then says "push to main" (deploys production). Build before committing.
- Git author is `MJMElon <elon.mjm@gmail.com>` (repo-local config; don't commit as any other identity).
- **DB migration ordering is critical:** when a change adds a synced column/table/bucket, the Supabase migration must run **before** the app deploy, or sync breaks for every device (`toServerTask` sends all columns on upsert; PostgREST rejects unknown columns). Workflow: write the SQL under `supabase/`, ask the user to run it in the Supabase SQL editor, **verify via anon REST probe** (e.g. `curl "$URL/rest/v1/workrecords_tasks?select=new_col&limit=1"` expecting 200), only then push.
- Supabase probes are done with curl + the anon key from `.env` (see `AGENTS.md` for what's safe). Storage policies must cover **both `anon` and `authenticated`** roles — operators run as anon, the HQ admin (Supabase Auth) as authenticated; an anon-only policy makes admin storage ops silently no-op (Supabase returns 200 with an empty result on unauthorized deletes).
- After deploys, remind the user that installed PWAs serve the cached bundle until refreshed/reopened (registerType `autoUpdate`) — "it's broken" is often a stale service worker.

## Architecture (the flow that spans files)

**Local-first data path:** UI pages → `src/db/repo.js` (the only mutation/query boundary; Dexie transactions, month-lock checks, tombstones) → `src/db/database.js` (Dexie schema, versioned migrations — always add a new version) → sync bus (`emitChange`) → `src/sync/syncEngine.js` picks up `syncStatus: 'pending'` rows.

**Sync engine order (per run):** push presets → push tasks → push photos (Storage upload + row upsert) → process tombstones (Storage file removal + soft-delete `deleted=true`) → pull presets → pull tasks/photos by `updated_at` cursor. Deletes propagate across devices via soft-delete rows, never hard deletes. Pulls must not overwrite newer pending local edits. `src/sync/mappers.js` converts camelCase ↔ snake_case both ways — a new synced field touches models.js, repo.js, mappers.js, and a SQL migration together (checklist in `AGENTS.md`).

**Server contract** (env-driven, `src/sync/supabase.js`): `public` schema, `workrecords_` table prefix via `tbl()`, `workrecords_photos` Storage bucket. `supabase/schema.sql` still describes the **legacy** `machinery-piecerate` schema — treat it as history, not truth; later files in `supabase/` are the incremental migrations.

**Auth split** (`src/auth/AuthContext.jsx`): operators/site-admins = local PIN sessions against synced operator records (localStorage `mpr.session`); HQ admin = Supabase Auth email/password. Route roles live in `src/App.jsx` (`RequireManager`, `AdminOnly` = HQ-admin only).

**Task lifecycle:** operator starts a task with a meter photo (photo 1 drives start time/GPS; photo 2 optional, no metadata) → task hangs `IN_PROGRESS` → finish form auto-saves drafts (debounced + flush on back/pagehide, all local-first via `saveTaskProgress`) → completion requires proof-of-work + ending-meter photos (end time comes from the ending-meter photo only). Photo capture (`src/components/PhotoCapture.jsx`) shows the image immediately with provisional time/GPS and refines EXIF/GPS in the background — don't reintroduce blocking detection.

**Money/precision conventions:** piece rates display full precision via `formatRate` (never round rates); amounts/subtotals round to 2dp (`round2`, `money`). Quantity fields accept arithmetic expressions (`src/lib/expr.js`, whitespace/newline tolerant) stored as `quantityExpr` alongside the computed `quantity`.

**Claims/payroll:** `buildAutoRows` (duplicated in `ClaimForm.jsx` and `AllClaims.jsx` — keep in sync) groups completed work by rate+area, hides rows with 0 qty and 0 amount; Bahagian B/C exist but are hidden behind `SHOW_INCENTIVES = false`. Salary/allowance rows appear only when preset on the operator. Printing = `window.print()` with `print:hidden` / `break-after-page`; PDF filenames come from `claimPdfName` (keeps `(Location)` suffixes so branches don't collide).

## UI conventions that matter here

Mobile-first for outdoor use: minimum `text-slate-500` for secondary text (never `slate-400` — contrast), ≥44px touch targets (`h-11 w-11` icon buttons), shared controls from `src/components/ui.jsx`, SVG icons from `src/components/icons.jsx`. The `ui-ux-pro-max` skill under `.claude/skills/` is available for design reviews. About-page version is injected from `package.json` via Vite `define` — bump with `npm version`.
