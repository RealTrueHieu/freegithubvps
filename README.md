# Free VPS GitHub

Deploy a free VPS using GitHub Actions — beautiful web interface powered by Cloudflare Workers.

## Features

- Email-based account creation (stored in Cloudflare KV)
- Secure GitHub Token input
- Auto-fork, secret creation, and workflow dispatch
- Real-time log viewer with terminal UI

## Deploy to Cloudflare Workers

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account

### Steps

```bash
# 1. Clone/copy this project
cd free-vps-github

# 2. Login to Cloudflare
wrangler login

# 3. Create KV namespace
wrangler kv namespace create USERS_KV
# Copy the output ID

wrangler kv namespace create USERS_KV --preview
# Copy the preview ID

# 4. Update wrangler.toml with the IDs from step 3
# Replace YOUR_KV_NAMESPACE_ID and YOUR_PREVIEW_KV_NAMESPACE_ID

# 5. Install dependencies
npm install

# 6. Test locally
npm run dev

# 7. Deploy!
npm run deploy
```

### Configuration

Edit `wrangler.toml`:

```toml
name = "free-vps-github"
main = "src/worker.js"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "USERS_KV"
id = "paste-your-kv-id-here"
preview_id = "paste-your-preview-kv-id-here"
```

## GitHub Token Permissions

Users need a Personal Access Token with these scopes:
- `repo` — Full control of private repositories
- `workflow` — Update GitHub Action workflows

Generate at: https://github.com/settings/tokens/new

## Architecture

```
┌──────────────────────────────────────┐
│         Cloudflare Worker            │
│                                      │
│  ┌─────────┐    ┌────────────────┐   │
│  │ Frontend │    │  API Routes    │   │
│  │  (HTML)  │───▶│  /api/login    │   │
│  │          │    │  /api/register │   │
│  └─────────┘    │  /api/fork     │   │
│                 │  /api/secret   │   │
│                 │  /api/run-wf   │   │
│                 │  /api/logs     │   │
│                 └───────┬────────┘   │
│                         │            │
│  ┌──────────┐    ┌──────▼──────┐     │
│  │    KV    │    │ GitHub API  │     │
│  │ (Users)  │    │  (Proxy)    │     │
│  └──────────┘    └─────────────┘     │
└──────────────────────────────────────┘
```

## Security Notes

- Passwords are hashed with SHA-256 + salt before storage
- GitHub tokens are never stored — only used per-session in the browser
- All GitHub API calls are proxied through the Worker (no CORS issues)

## License

MIT
