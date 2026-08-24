# Machinery Piece Rates

An **offline-first PWA** for heavy-machine operators to record piece-rate work, plus an admin side to manage rates/areas/operators and correct records. Built with **React + Vite + Dexie (IndexedDB) + Supabase**.

- Works fully **offline** after the first online load; records and photos are saved on the device and **sync automatically** when the connection returns.
- Photos store their **timestamp + GPS** (read from the photo's EXIF, falling back to the live device GPS/clock when the file has none).
- Operators take a **start-mileage** + **work** photo to open a task, then finish it later with an **end-mileage** photo, piece rate, quantity and area. **Duration is auto-calculated** from the two photo times.
- The monthly **summary** merges the same piece rate on the same day into one line (tap to expand the individual records).

---

## 1. Prerequisites

- **Node.js 18+** (tested on Node 24)
- The Supabase project (already configured in `.env`)

## 2. First-time setup

```bash
npm install
```

Your `.env` is already filled in for the Supabase project `qcvbzzdbbqmnrljfnxjp`. (To use a different project, copy `.env.example` to `.env` and fill it in.)

### 2a. Set up the database (one time)

1. Open **Supabase dashboard → SQL Editor → New query**.
2. Paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql) and **Run**.
   - This creates the **`machinery-piecerate`** schema, all tables (companies, machines, piece_rates, areas, tasks, photos), and the public **`photos`** storage bucket.
   - The script is **idempotent** — safe to re-run. If you ran an earlier version, just run it again to add the new `companies`/`machines` tables and task columns.
3. **Expose the schema to the API** (required): **Project Settings → API → "Exposed schemas"** → add `machinery-piecerate` → **Save**.

That's it — no bucket or policy clicking needed; the SQL does it.

## 3. Run it locally

```bash
npm run dev      # http://localhost:5173
```

Open it on your computer at `http://localhost:5173`.

> **Testing on a real phone:** camera GPS, the PIN/password hashing, and PWA install all require a **secure context (HTTPS)**. `localhost` counts as secure, but a plain `http://192.168.x.x` LAN address does **not**. To test on a phone, either:
> - **Deploy it** (see §6) and open the HTTPS URL, **or**
> - run a quick HTTPS tunnel, e.g. `npx cloudflared tunnel --url http://localhost:5173` (or `ngrok http 5173`), and open the HTTPS link it prints.

## 4. Logging in

### Operators
Operators are organised as **Company → Machine**. Login is: **pick Company → pick Machine → enter the machine PIN → type your name**. Your name is remembered on the device and is what shows on the salary-claim summary (operators aren't pre-created — they just type their name).

A demo company + machine is seeded so you can try it immediately:
- **Company:** Demo Company  **Machine:** Excavator 1  **PIN:** `1234`  → then type any name.

Add real companies & machines (and set/reset machine PINs) in **Admin → Settings → Companies / Machines**.

### Admin
The **first time** you open the Admin side, you'll be asked to **create the admin password**. You'll then be shown a **recovery code once** — write it down.

## 5. Forgot a PIN or password?

- **Forgot a machine PIN** → Admin opens **Settings → Machines → (machine) → Reset PIN**.
- **Admin forgot the password** → on the admin login screen tap **"Forgot password?"**, enter the **recovery code**, and set a new one (a fresh recovery code is issued).
- **Lost the recovery code too?** While logged in as admin, **Settings → Security → Generate new recovery code**. As a last resort the admin auth lives only on the device — clearing the site data and re-running first-time admin setup resets it (existing records are kept in Supabase).

> The admin password / recovery code and machine PINs are stored **hashed on the device** (and synced as hashes). They are a convenience gate for offline use — see **Hardening** below for production-grade auth.

## 6. Deploy live on GitHub Pages (free HTTPS)

This repo is preconfigured for GitHub Pages: a sub-path build base, hash-based
routing (no 404s), the public Supabase values in `.env.production`, and an
auto-deploy workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

**One-time setup:**

1. **Create a GitHub repo** and push this folder:
   ```bash
   git init
   git add -A
   git commit -m "Machinery Piece Rates PWA"
   git branch -M main
   git remote add origin https://github.com/<your-username>/Machinery-PieceRates.git
   git push -u origin main
   ```
   (Use a repo named `Machinery-PieceRates`, or any name — the workflow adapts the URL sub-path automatically.)
2. In the repo on github.com: **Settings → Pages → Build and deployment → Source → "GitHub Actions"**.
3. The **Deploy to GitHub Pages** action runs on every push. When it finishes (Actions tab → green check), your live URL is:
   `https://<your-username>.github.io/<repo-name>/`
4. **Supabase still needs the schema exposed** (see §2a): Settings → API → Exposed schemas → add `machinery-piecerate`. The app's data only syncs once that's done.

After that, every `git push` redeploys automatically. Open the live URL on a phone and use **"Add to Home Screen"** to install it as an app.

> ⚠️ A public Pages site + the current open access rules = **anyone with the URL can read/write the data**. Fine for a private trial; before storing real data, do the **Hardening** in §9.

> Prefer Vercel/Netlify instead? Connect the same GitHub repo, set build command `npm run build` and output `dist`, and add the four `VITE_SUPABASE_*` env vars in their dashboard.

## 7. How the data flows

```
Operator/Admin action
      │
      ▼
IndexedDB (Dexie)  ── instant, works offline, syncStatus = "pending"
      │
      ▼  (when online)
Sync engine  ── push tasks → push photos → process deletes → pull presets & other-device records
      │
      ▼
Supabase  (schema "machinery-piecerate" + Storage bucket "photos")
```

- **Photos** are downscaled (~1600px JPEG) before saving so many fit in IndexedDB and upload quickly.
- Every record carries a **sync dot**: amber = waiting, green = synced. The top bar shows overall sync status.

## 8. Project structure

```
src/
  db/         database.js (Dexie schema + seed), models.js (enums/types), repo.js (all CRUD)
  lib/        photoMeta.js (EXIF+GPS), image.js (compress), duration.js, format.js, summary.js, crypto.js, uuid.js
  sync/       supabase.js (client on custom schema), syncEngine.js, mappers.js, useSync.js, bus.js
  auth/       AuthContext.jsx, Login.jsx
  components/ Shell.jsx (nav), PhotoCapture.jsx, PhotoThumb.jsx, MonthSummary.jsx, ui.jsx, icons.jsx …
  pages/
    operator/ NewTask, OpenTasks, CompleteTask, OperatorSummary
    admin/    AdminRecords, EditTask, AddTask, Settings
supabase/schema.sql
scripts/gen-icons.mjs
```

## 9. Hardening (before real production)

The app currently talks to Supabase with the public **anon key** and the SQL grants the anon role full access. That's fine for a small, trusted pilot, but means anyone with the URL + anon key can read/write the data. For production:

1. Move authentication to **Supabase Auth** (e.g. magic-link or email/password) and keep a Supabase session per user.
2. Replace the permissive `app_all` RLS policies in `supabase/schema.sql` with **per-user / role-based** policies (operators see only their own rows; admins see all).
3. Make the `photos` bucket **private** and serve images via **signed URLs**.

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Top bar shows **"Sync error"** | Make sure you ran `supabase/schema.sql` **and** added `machinery-piecerate` to **Exposed schemas**. |
| Photos sync but don't show on another device | Confirm the `photos` bucket exists and is **public** (the SQL sets this). |
| On a phone the camera/GPS/login does nothing | You're on `http://` (not secure). Use the deployed HTTPS URL or a tunnel (see §3). |
| "No location found" on a photo | Allow location permission, or upload a gallery photo that has GPS in its EXIF. |
| Changed the SQL / want a clean device | Browser DevTools → Application → Clear storage (wipes the local IndexedDB; cloud data stays). |

## 11. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the dev server (service worker enabled for offline testing) |
| `npm run build` | Production build into `dist/` (also regenerates icons) |
| `npm run preview` | Serve the production build locally |
| `npm run gen-icons` | Regenerate PWA icons from `public/logo.svg` |
