# DHIS2 MCP Server — Kwara State RI

A remote MCP server that lets Claude query your DHIS2 instance directly in
chat — no more running scripts and reading execution logs. Ask things like
*"what was Penta1 coverage in Ilorin South LGA from January to June?"*
and Claude calls this server, which calls DHIS2, and answers you directly.

## How it's secured

- Your DHIS2 Personal Access Token lives only in this server's own
  environment variables. It is never sent to Claude or visible in any chat.
- This server itself is protected by a single shared-secret header
  (`X-MCP-Key`). Only requests carrying the exact key you set get through —
  everything else is rejected with 401 before touching DHIS2.
- This is simpler than full OAuth, which is appropriate here because this
  server has exactly one intended user (you). If you ever want to share
  access with others, that's a bigger step (proper OAuth) — ask and I can
  build that layer too.

## What Claude can do with it

- `dhis2_find_org_unit` — resolve a place name ("Ilorin South") to its DHIS2 ID
- `dhis2_list_org_unit_children` — list LGAs under the state, or facilities under an LGA
- `dhis2_list_org_units_by_level` — list every facility (or LGA) under an ancestor in one call
- `dhis2_find_antigen` — resolve an antigen name ("Penta1") to its data element ID, automatically skipping vaccine stock/logistics entries
- `dhis2_get_coverage` — get dose counts for specific org unit(s) and period(s)
- `dhis2_get_coverage_by_level` — get dose counts for every facility (or LGA) under an ancestor at once

Claude chains these automatically — you don't need to know the tool names,
just ask your question naturally.

---

## Deploying (Render.com — free tier, ~10 minutes)

Render is used here because it has a genuinely free tier for small services
and a simple Git-based deploy flow. Railway or Fly.io work similarly if you
prefer either of those instead.

### 1. Push this folder to a GitHub repo

```bash
cd dhis2-mcp-server
git init
git add .
git commit -m "DHIS2 MCP server"
```

Create a new repository on GitHub (make it **private** — this is your
personal infrastructure), then:

```bash
git remote add origin https://github.com/<your-username>/dhis2-mcp-server.git
git branch -M main
git push -u origin main
```

### 2. Create the Render Web Service

1. Go to [render.com](https://render.com) and sign in (GitHub sign-in is easiest).
2. **New +** → **Web Service** → connect your `dhis2-mcp-server` repo.
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance type**: Free
4. Under **Environment Variables**, add:
   | Key | Value |
   |---|---|
   | `DHIS2_BASE_URL` | `https://dhis2nigeria.org.ng/dhis` |
   | `DHIS2_TOKEN` | *your DHIS2 Personal Access Token* |
   | `MCP_SHARED_KEY` | *a long random string — generate one below* |

   Generate a random key locally:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
5. Click **Create Web Service**. Wait for the build/deploy to finish (a few minutes on the free tier).
6. Once live, note your service URL — something like `https://dhis2-mcp-server.onrender.com`. Your MCP endpoint is that URL + `/mcp`.

**Free tier note**: Render's free web services sleep after inactivity and
take ~30-50 seconds to wake on the next request. Your first question after a
gap may feel slow; after that it's fast until it sleeps again. Fine for
personal use; upgrade to a paid instance later if that lag bothers you.

### 3. Add it to Claude as a custom connector

1. In Claude, go to **Settings → Connectors → Add custom connector**.
2. **Name**: `dhis2-kwara` (lowercase, hyphens only)
3. **Remote** → paste your Render URL + `/mcp`, e.g.
   `https://dhis2-mcp-server.onrender.com/mcp`
4. Open **Advanced settings** → find the **Headers helper** → add:
   - Header name: `X-MCP-Key`
   - Header value: *the same random string you set as `MCP_SHARED_KEY`*
5. Click **Add**.
6. In a chat, click **+ → Connectors**, toggle `dhis2-kwara` on, and ask your question.

### 4. Rotate your DHIS2 token one more time

Since the token has been visible in chat/screenshots during earlier testing,
generate a fresh one in DHIS2's Update Details screen and use *that* as
`DHIS2_TOKEN` here — this will be the last time it needs to exist outside
DHIS2's own UI.

---

## Local development

```bash
npm install
npm run build
DHIS2_BASE_URL=https://dhis2nigeria.org.ng/dhis \
DHIS2_TOKEN=your_token \
MCP_SHARED_KEY=some_local_test_key \
npm start
```

Test with the MCP Inspector:
```bash
npx @modelcontextprotocol/inspector
```
Point it at `http://localhost:3000/mcp` with the `X-MCP-Key` header set.
