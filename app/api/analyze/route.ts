export const runtime = "nodejs";

const TIMEOUT_MS = 8000;

async function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

type AnalyzeBody = {
  instrument: string;
  tf: ("M15" | "H1" | "D1")[];
  count?: number;
  indicators?: unknown;
};

export async function POST(req: Request) {
  const BASE = process.env.INDICATORS_BASE_URL;
  if (!BASE) {
    return new Response(JSON.stringify({ ok: false, error: "INDICATORS_BASE_URL is not set" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const { instrument, tf, count = 240, indicators } = (await req.json()) as AnalyzeBody;
    if (!instrument || !tf?.length) {
      return new Response(JSON.stringify({ ok: false, error: "instrument and tf are required" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    const ensureRes = await withTimeout(
      fetch(`${BASE}/v1/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, tf, count, indicators }),
      }),
      TIMEOUT_MS
    );
    if (!ensureRes.ok) {
      const t = await ensureRes.text();
      return new Response(JSON.stringify({ ok: false, step: "ensure", error: t }), {
        status: 502, headers: { "Content-Type": "application/json" }
      });
    }
    const ensureJson = await ensureRes.json();

    const pick = tf.includes("H1") ? "H1" : tf[0];
    const key = ensureJson?.cache_keys?.[pick];
    if (!key) {
      return new Response(JSON.stringify({ ok: false, error: "cache key not found" }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    const seriesRes = await withTimeout(fetch(`${BASE}/v1/series?key=${encodeURIComponent(key)}`), TIMEOUT_MS);
    if (!seriesRes.ok) {
      const t = await seriesRes.text();
      return new Response(JSON.stringify({ ok: false, step: "series", error: t }), {
        status: 502, headers: { "Content-Type": "application/json" }
      });
    }
    const series = await seriesRes.json();

    return new Response(JSON.stringify({ ok: true, latest: ensureJson.latest, key, raw: series }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
