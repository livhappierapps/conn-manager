# conn-manager

Shared connection layer for Liv Happier apps (Middlemain, Eden Mux, Crash Pad, Memory Machine).
Zero runtime dependencies; plain `fetch`, so it runs in Node 18+, React Native (Expo) and browsers.

| Module | Status |
| --- | --- |
| `memory` — Memory Machine context injection (search, rank, profile layer) | **built** |
| Network auto-failover (Wi-Fi / hotspot / cellular), retry queue, connection history | planned, not built yet |

## memory: one memory layer, every app drinks from it

```ts
import { injectMemoryContext } from "@livhappierapps/conn-manager/memory";

const { systemPrompt } = await injectMemoryContext(baseSystemPrompt, userMessage, {
  baseUrl: process.env.MEMORY_MACHINE_URL,          // e.g. https://memory-machine-api.onrender.com
  getToken: () => clerkJwtFromRequest,              // user's Clerk session JWT (preferred)
  serviceKey: process.env.MEMORY_MACHINE_SERVICE_KEY, // server-only fallback (one owner account)
  timeoutMs: 1500,                                  // hard budget; on timeout/error the prompt is returned unchanged
});
```

What it does on every call (never throws, never blocks longer than `timeoutMs`):

1. **Search**: pulls non-stopword keywords from the user message and calls
   `GET /v1/memories?q=<keywords>&match=any&limit=25` (wider candidate set).
2. **Rank** (`rankMemories`) down to the top 5:
   `score = 0.6·keywordOverlap + 0.25·freshness + 0.25·highStakes`
   - keyword overlap: title hits count double, body hits single, +0.2 for a verbatim phrase match;
   - freshness: `0.5^(ageDays / halfLifeDays)`, half-life 45 days;
   - high-stakes (DHS, court, custody, ICWA, hearing, medical, camper, …, see `DEFAULT_HIGH_STAKES_TERMS`):
     flat boost **and** a freshness floor of 0.8, so load-bearing old memories don't fade or get buried;
   - fresh-but-irrelevant memories are dropped. Every weight/term list is an option.
3. **Profile layer**: `GET /v1/profile` (cached in-process 10 min per user) is added as the baseline
   "About the user" block; the ranked matches follow as a "Relevant memories" block
   (kind, title, truncated body, occurredAt).

### Standing profile rebuild

`rebuildProfile({ client, summarize })` pages through memories newest-first with `before=`,
**incrementally** (only memories newer than `metadata.newestCreatedAt` of the last build; zero LLM
calls when nothing changed), folds them into the previous profile with the caller's LLM (`summarize`),
and stores it with `PUT /v1/profile`. Cost guards: `maxMemories` (400), `chunkChars` (48k),
`maxLlmCalls` (4). Section headings are generic (`DEFAULT_PROFILE_SECTIONS`); every fact comes from
the user's memories at build time, nothing personal lives in code.

Run it on a schedule (nightly), not per chat. The cheapest options, in order:
GitHub Actions scheduled workflow calling the app's rebuild endpoint (free) → Render cron job
(`$0.00016/min`, **$1/month minimum per cron job**) → lazy rebuild-if-stale inside the app server.

### Auth

- **User path**: the app gets a Clerk session JWT (Sign in with Apple via Clerk) and sends it to its own
  backend, which forwards it to Memory Machine as `Authorization: Bearer`. Memory Machine verifies it
  against `CLERK_ISSUER`'s JWKS.
- **Server path**: `x-mm-service-key` (Memory Machine `SERVICE_KEY` + `SERVICE_KEY_CLERK_USER_ID`), bound to
  one owner account, read-only plus profile writes. For scheduled jobs with no live session. Never ship it in an app bundle.

## Adopting it in another app

The code lives here once. Apps consume it either as a git dependency
(`"@livhappierapps/conn-manager": "github:livhappierapps/conn-manager#<tag-or-sha>"`; this repo is public)
or as a pinned vendored copy (Middlemain vendors `src/memory` into
`artifacts/api-server/src/lib/memory/` with the source commit recorded in `VENDORED.md`, because its Render
build runs `pnpm install --frozen-lockfile` and must not depend on an unmerged branch). Never fork the logic.

### Eden Mux (`livhappierapps/EdenMux`)

- Hook point: `server/eden.ts` → `handleEdenChat`, right where `buildSystemPrompt(platform, memory, …)`
  is built, before the `fetch("https://api.x.ai/v1/chat/completions")` call. Wrap the result:
  `systemContent = (await injectMemoryContext(systemContent, lastUserMessage, opts)).systemPrompt`.
- Auth: Eden Mux has its own accounts (`/api/auth/*`, incl. `/api/auth/apple`), not Clerk. Until it moves to
  Clerk, use the owner-only service key for the owner's account, or add Clerk and forward the JWT.
- Profile: reuse the same Memory Machine profile (one per Clerk user); no second rebuild job needed.

### Crash Pad (`livhappierapps/craishpad`, plus `leoscraishpad` / `craishpad-replit`)

- `craishpad` is a handoff repo (docs + icon, no app code yet). When its backend chat route is built,
  call `injectMemoryContext` before the model call, exactly as above, and use Clerk from day one so the
  user's JWT is forwarded.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```
