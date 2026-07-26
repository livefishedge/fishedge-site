# FishEdge

**Live marine intelligence for tournament captains.**

This is the customer-facing product of **DataNinjaAI** at
**[fishedge.live](https://fishedge.live)**.

## What lives here

```
/
├── index.html, style.css, hero.svg, tournaments.js, README.md  →  landing page
└── dashboard/                                                   →  Captain's Dashboard
    ├── index.html, index-usec_*.json, sync_manifest.json        →  viewer
    ├── login.html, register.html, account.html, profile-edit.html,
    │   verify-email.html, supabase-init.js                      →  auth
    └── .nojekyll, LICENSE, SUPABASE_AUTH_CONFIG.md
```

## Live URLs

| URL | Purpose |
|---|---|
| `https://fishedge.live` | Marketing landing page |
| `https://www.fishedge.live` | Marketing landing page (www) |
| `https://app.fishedge.live/dashboard/` | Captain's Dashboard |
| `https://data.fishedge.live/data/...` | Viewer data (Cloudflare R2, last 14 days) |
| `https://livefishedge.github.io/view/` | **Original GitHub Pages viewer — UNTOUCHED, rollback/fallback** |

## Architecture

- **Hosting:** Cloudflare Pages
- **Domain:** Cloudflare DNS (apex + www + app + data)
- **Email:** Cloudflare Email Routing → `captains@fishedge.live`
- **Data:** Cloudflare R2 (`fishedge-data`), public, last 14 days rolling window
- **Auth:** Supabase (unchanged from `livefishedge/view`)
- **Local pipeline:** Unchanged. Downloads, processes, generates files locally.
  `rclone` syncs the last-14-day subset to R2 every 6 hours.

## Why GitHub Pages still serves

The `livefishedge/view` repo on GitHub Pages is **deliberately untouched**.
It is the rollback path. If FishEdge breaks for any reason, the captain can
return to the old URL and still see the same data.

## Brand

- **Product:** FishEdge — productive ocean edges + competitive edge.
- **Company:** DataNinjaAI
- **Domain:** `fishedge.live`
- **Email:** `captains@fishedge.live`

## Local development

Static. No build step.

```bash
# Test landing page
python3 -m http.server 8000
# open http://localhost:8000

# Test dashboard
python3 -m http.server 8000 --directory dashboard 8001
# open http://localhost:8001/
```

## Editing the tournament calendar

Edit the `TOURNAMENTS` array in `tournaments.js`.

Past tournaments auto-hide based on end date.