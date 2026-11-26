import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildMemoryBlock,
  buildProfileBlock,
  clearProfileCache,
  createMemoryClient,
  extractKeywords,
  injectMemoryContext,
  isProfileStale,
  rankMemories,
  rebuildProfile,
  type Memory,
} from "../src/memory";

const DAY = 86_400_000;
const NOW = new Date("2026-11-26T12:00:00Z");
const mem = (id: string, title: string, body: string, ageDays: number, kind = "note"): Memory => ({
  id,
  kind,
  title,
  body,
  occurredAt: null,
  createdAt: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
});

function fakeFetch(routes: Record<string, (url: URL, init?: RequestInit) => unknown>, delayMs = 0) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const out = h(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(() => clearProfileCache());

describe("rankMemories", () => {
  it("prefers relevance over newest, keeps old high-stakes items, drops fresh noise", () => {
    const items = [
      mem("new-noise", "Lunch", "had soup today", 0),
      mem("new-match", "Camper roof", "roof leak patched, need sealant", 2),
      mem("old-court", "Court date", "hearing set, bring roof inspection paperwork", 400),
      mem("old-plain", "Roof idea", "maybe paint roof", 400),
    ];
    const ranked = rankMemories(items, "what do I need for the roof?", { now: NOW });
    const ids = ranked.map((r) => r.id);
    expect(ids).not.toContain("new-noise");
    expect(ids[0]).toBe("new-match");
    expect(ids.indexOf("old-court")).toBeLessThan(ids.indexOf("old-plain"));
    expect(ranked.find((r) => r.id === "old-court")!.highStakes).toBe(true);
  });

  it("applies half-life decay and is configurable", () => {
    const a = mem("a", "Garden", "tomatoes", 45);
    const [r] = rankMemories([a], "garden", { now: NOW, halfLifeDays: 45 });
    expect(r!.freshness).toBeCloseTo(0.5, 2);
    const custom = rankMemories([mem("b", "Garden", "x", 1)], "garden", { now: NOW, highStakesTerms: ["garden"] });
    expect(custom[0]!.highStakes).toBe(true);
    expect(rankMemories(Array.from({ length: 30 }, (_, i) => mem(String(i), "garden", "", i)), "garden", { now: NOW })).toHaveLength(5);
  });

  it("skips the profile row and duplicate ids", () => {
    const p = { ...mem("p", "Standing profile", "garden", 0), sourcePath: "mm://profile" };
    expect(rankMemories([p, mem("x", "garden", "", 1), mem("x", "garden", "", 1)], "garden", { now: NOW }).map((r) => r.id)).toEqual(["x"]);
  });
});

describe("blocks", () => {
  it("formats kind, title, truncated body and date", () => {
    const b = buildMemoryBlock([{ ...mem("1", "T", "x".repeat(500), 0, "conversation"), occurredAt: "2026-01-02T00:00:00Z" }], { bodyChars: 50 });
    expect(b).toContain("Relevant memories");
    expect(b).toContain("[conversation] T (occurred 2026-01-02)");
    expect(b.split("\n")[1]!.length).toBeLessThan(120);
    expect(buildMemoryBlock([])).toBe("");
    expect(buildProfileBlock(null)).toBe("");
    expect(buildProfileBlock({ body: "Likes neon", metadata: { builtAt: "2026-11-25T03:00:00Z" } })).toContain("2026-11-25");
  });
  it("extracts keywords without stopwords", () => {
    expect(extractKeywords("What is the date of my court hearing?")).toEqual(["hearing", "court", "date"]);
  });
});

describe("injectMemoryContext", () => {
  it("adds profile + memories with Bearer token and match=any", async () => {
    const seen: Record<string, string | null> = {};
    const f = fakeFetch({
      "GET /v1/memories": (url, init) => {
        seen.q = url.searchParams.get("q");
        seen.match = url.searchParams.get("match");
        seen.limit = url.searchParams.get("limit");
        seen.auth = new Headers(init?.headers).get("authorization");
        return { items: [mem("1", "Court hearing", "moved to Friday", 3)] };
      },
      "GET /v1/profile": () => ({ body: "Prefers short answers.", metadata: { builtAt: "2026-11-25T00:00:00Z" } }),
    });
    const r = await injectMemoryContext("BASE", "when is my court hearing", { baseUrl: "https://mm.test/", getToken: () => "jwt-token", fetch: f, now: NOW });
    expect(seen).toMatchObject({ match: "any", limit: "25", auth: "Bearer jwt-token" });
    expect(seen.q).toContain("court");
    expect(r.systemPrompt.startsWith("BASE\n\nAbout the user")).toBe(true);
    expect(r.systemPrompt).toContain("Relevant memories");
    expect(r.profileIncluded).toBe(true);
    expect(r.memories).toHaveLength(1);
  });

  it("uses the service key when there is no token", async () => {
    let key: string | null = null;
    const f = fakeFetch({
      "GET /v1/memories": (_u, init) => {
        key = new Headers(init?.headers).get("x-mm-service-key");
        return { items: [] };
      },
    });
    const r = await injectMemoryContext("BASE", "garden plans", { baseUrl: "https://mm.test", serviceKey: "svc", fetch: f });
    expect(key).toBe("svc");
    expect(r).toMatchObject({ systemPrompt: "BASE", skipped: "empty" });
  });

  it("fails silently and fast when Memory Machine is down or slow", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const onError = vi.fn();
    const r1 = await injectMemoryContext("BASE", "court", { baseUrl: "https://mm.test", serviceKey: "k", fetch: down, onError });
    expect(r1.systemPrompt).toBe("BASE");
    expect(onError).toHaveBeenCalled();

    const slow = fakeFetch({ "GET /v1/memories": () => ({ items: [mem("1", "court", "", 1)] }), "GET /v1/profile": () => ({ body: "x", metadata: {} }) }, 3000);
    const t0 = Date.now();
    const r2 = await injectMemoryContext("BASE", "court", { baseUrl: "https://mm.test", serviceKey: "k", fetch: slow, timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(r2.systemPrompt).toBe("BASE");

    const r3 = await injectMemoryContext("BASE", "court", {});
    expect(r3.skipped).toBe("not_configured");
  });

  it("caches the profile per user", async () => {
    const f = fakeFetch({ "GET /v1/memories": () => ({ items: [] }), "GET /v1/profile": () => ({ body: "P", metadata: {} }) });
    const tok = `x.${Buffer.from(JSON.stringify({ sub: "user_1" })).toString("base64url")}.y`;
    await injectMemoryContext("", "hello there friend", { baseUrl: "https://mm.test", getToken: () => tok, fetch: f });
    await injectMemoryContext("", "hello there friend", { baseUrl: "https://mm.test", getToken: () => tok, fetch: f });
    const profileCalls = (f as unknown as { mock: { calls: [string][] } }).mock.calls.filter(([u]) => String(u).endsWith("/v1/profile"));
    expect(profileCalls).toHaveLength(1);
  });
});

describe("rebuildProfile", () => {
  it("pages with before=, summarizes oldest-first, stores metadata; skips the LLM when unchanged", async () => {
    const all = Array.from({ length: 5 }, (_, i) => mem(`m${i}`, `Memory ${i}`, `body ${i}`, i));
    let stored: { body: string; metadata: Record<string, unknown> } | null = null;
    const befores: (string | null)[] = [];
    const f = fakeFetch({
      "GET /v1/profile": () => (stored ? stored : new Response("{}", { status: 404 })),
      "PUT /v1/profile": (_u, init) => {
        stored = JSON.parse(String(init!.body));
        return stored;
      },
      "GET /v1/memories": (url) => {
        if (url.searchParams.get("match") === "any") return { items: [mem("old", "Court order", "custody", 900)] };
        const before = url.searchParams.get("before");
        befores.push(before);
        const lim = Number(url.searchParams.get("limit"));
        const rows = all.filter((m) => !before || Date.parse(m.createdAt) < Date.parse(before));
        return { items: rows.slice(0, lim) };
      },
    });
    const client = createMemoryClient({ baseUrl: "https://mm.test", serviceKey: "k", fetch: f });
    const summarize = vi.fn(async ({ user }: { system: string; user: string }) => `PROFILE from ${user.split("\n").filter((l) => l.startsWith("- ")).length}`);
    const r = await rebuildProfile({ client, summarize, pageSize: 2, now: NOW, model: "test" });
    expect(r).toMatchObject({ status: "rebuilt", newMemories: 6, llmCalls: 1 });
    expect(befores.length).toBeGreaterThanOrEqual(3);
    expect(summarize.mock.calls[0]![0].user.indexOf("Court order")).toBeLessThan(summarize.mock.calls[0]![0].user.indexOf("Memory 4"));
    expect(stored!.metadata).toMatchObject({ newestCreatedAt: all[0]!.createdAt, memoryCount: 6, model: "test" });

    const again = await rebuildProfile({ client, summarize, pageSize: 2, now: NOW });
    expect(again.status).toBe("unchanged");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(isProfileStale(stored as never, 24, new Date(NOW.getTime() + 2 * DAY))).toBe(true);
    expect(isProfileStale(stored as never, 24, NOW)).toBe(false);
  });
});
