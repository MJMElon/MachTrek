# AGENTS.md

## Scope

These instructions apply to the entire repository.

This is a mobile-first, offline-first PWA for machinery piece-rate work. The stack is React 18, Vite 5, plain JavaScript/JSX with ESM, Tailwind CSS, Dexie/IndexedDB, Supabase, and `vite-plugin-pwa`.

## Current source of truth

- Treat the running code, `.env.example`, and `src/sync/supabase.js` as authoritative for current behavior.
- The current backend contract is the `public` schema, `workrecords_` table prefix, and `workrecords_photos` Storage bucket.
- Parts of `README.md` and `supabase/schema.sql` still describe the legacy `machinery-piecerate` schema, `photos` bucket, machine-PIN login, and local HQ-admin recovery flow. Verify those sections against the code before relying on them, and update affected documentation when changing behavior.
- Current authentication is:
  - operators and site admins: synced operator records with locally verified username/PIN sessions;
  - HQ admin: Supabase Auth email/password session.

## Architecture boundaries

- `src/main.jsx` owns startup sequencing: seed/migrate or repair local data, enforce retention, then start background sync.
- `src/db/database.js` owns the Dexie database and versioned local-schema migrations.
- `src/db/repo.js` is the application query/mutation boundary. Pages and components should use repository functions rather than write directly to Dexie or Supabase.
- `src/sync/mappers.js` translates local camelCase/nested-GPS records to server snake_case/flat-column records in both directions.
- `src/sync/syncEngine.js` owns application-data push, pull, conflict handling, retry, and tombstone processing. Direct Supabase access outside the sync layer is limited to authentication and narrowly justified infrastructure operations.
- `src/App.jsx` owns route and role authorization. Keep operator, site-admin, and HQ-admin permissions consistent across routes and repository operations.

## Offline-first and data invariants

- Save user work to Dexie first. A network connection must not be required for ordinary operator capture or task completion.
- Client-created records use stable UUIDs. Mutations must update `updatedAt`, set `syncStatus` to `pending`, and notify the sync bus after a successful local transaction.
- Keep related task/photo writes transactional. Never leave a task pointing at a photo that was not saved, or delete a photo without updating its task.
- Deletions that must propagate to other devices require tombstones. Do not replace repository deletion flows with direct `db.<table>.delete()` calls.
- Preserve the sync engine's protection for newer unsynced local edits. A pull must not overwrite a more recent pending local change.
- Completed tasks retain historical snapshots such as operator, company, machine, rate name, unit price, quantity, and amount. Do not silently recalculate old work from current presets.
- Enforce month locks for every create, edit, delete, and payroll-affecting operation in a locked month.
- Retention is based on the task or claim `monthKey` and currently keeps 36 months. New monthly data must participate in retention deliberately.
- Read photo EXIF/GPS metadata before destructive image processing. Preserve capture time, GPS source, and local Blob behavior when changing photo flows.

## Data-model changes

When adding or changing persisted fields or synced entities, review and update all applicable layers together:

1. Add a new Dexie version in `src/db/database.js`; do not rewrite an already-released version.
2. Update model documentation/enums in `src/db/models.js`.
3. Update repository creation, editing, deletion, lock, transaction, and retention behavior in `src/db/repo.js`.
4. Update both directions in `src/sync/mappers.js`.
5. Update sync push/pull, pending counts, tombstones, and cursors in `src/sync/syncEngine.js` as needed.
6. Add an explicit, reviewable SQL migration under `supabase/`; keep table prefixes and bucket names aligned with the environment contract.
7. Update setup and operational documentation affected by the change.

Migrations must preserve data already stored in installed PWAs and in Supabase. Do not assume a clean browser database.

## Supabase and production safety

- Treat every file under `supabase/` as manual, potentially production-affecting DBA work. Do not execute SQL without explicit user authorization and confirmation of the target project.
- Some SQL changes move or rename tables, alter open RLS policies, modify Storage, or purge retained data. Inspect the whole script and confirm backup/recovery expectations before execution.
- All `VITE_*` values are shipped to clients. Never put a `service_role` key, database password, or other secret in `.env`, `.env.production`, frontend code, or Git history.
- The tracked Supabase anon key is public by design, but the current permissive access model is not suitable for untrusted production use.
- Do not run synthetic/browser tests against the default live Supabase configuration. Use a dedicated test backend or an explicitly local-only configuration and a disposable browser profile.
- Service workers and IndexedDB persist across runs. Before clearing site data, verify the profile is disposable or that all real local work is synced and recoverable.

## PWA and deployment constraints

- Preserve `HashRouter`, dynamic `VITE_BASE`, relative manifest `start_url`/`scope`, and GitHub Pages sub-path support unless deployment architecture is intentionally changed.
- Keep Supabase API and Storage traffic outside service-worker navigation handling.
- Development enables the service worker, so stale caches can affect QA. Test upgrades and offline/reconnect flows in an isolated profile.
- A push to `main` triggers GitHub Pages deployment. Do not push or deploy unless the user explicitly requests it.
- Do not hand-edit generated `dist/`, `dev-dist/`, or PWA icon PNG files. `public/logo.svg` is the icon source.

## UI conventions

- Keep the operator experience mobile-first, usable outdoors, and friendly to one-handed operation.
- Reuse shared controls from `src/components/ui.jsx` and existing icons before introducing one-off components or another UI library.
- Maintain at least 44px touch targets, visible focus states, readable contrast, explicit labels, and 16px form controls to avoid mobile browser zoom.
- Preserve safe-area handling and the app's `max-w-app` layout. Check print-specific payroll and claim layouts after changing shared CSS.

## Commands and verification

- Use Node.js 20 when practical to match GitHub Actions. The documented minimum is Node.js 18.
- Available commands:
  - `npm run dev` — local Vite server with the development service worker;
  - `npm run build` — production build and minimum required automated verification;
  - `npm run preview` — serve the production build;
  - `npm run gen-icons` — regenerate PWA icons from `public/logo.svg`.
- There are currently no test, lint, formatting, or type-check scripts. Do not claim those checks passed.
- Run `npm run build` after code changes. For auth, persistence, photo, routing, or sync changes, also document relevant manual checks, including offline save, reload persistence, reconnect sync, and a second-device pull when applicable.

## Working agreements

- Inspect `git status` before editing and preserve unrelated or untracked user work. The `.agents/` directory may be untracked and must not be removed or overwritten incidentally.
- Keep changes focused. Do not add production dependencies, run database migrations, clear stored data, push commits, or deploy without the authority appropriate to that action.
- Prefer comments that explain non-obvious invariants and failure modes. Avoid comments that merely restate the code.
