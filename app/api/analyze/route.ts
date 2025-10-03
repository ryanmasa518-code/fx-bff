export const runtime = "nodejs";

const TIMEOUT_MS = 15000;

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

type PresetName = "default" | "light" | "trend" | "mean_revert";

const PRESETS: Record<PresetName, any> = {
  default: {
    rsi: { period: 14 },
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stddev: 2 },
    sma: [{ period: 20 }, { period: 50 }],
    ema: [{ period: 20 }, { period: 50 }],
  },
  light: {
    rsi: { period: 14 },
  },
  trend: {
    sma: [{ period: 50 }, { period: 200 }],
    ema: [{ period: 20 }, { period: 50 }],
  },
  mean_revert: {
    rsi: { period: 14 },
    bb: { period: 20, stddev: 2 },
  },
};

// /api/analyze で preset を受けたら indicators にマージ
// body: { instrument: string, tf: string[], count: number, indicators?: {...}, preset?: PresetName }

function summarize(latest: any) {
  const notes: string[] = [];

  if (latest?.rsi?.value !== undefined) {
    const r = latest.rsi.value;
    if (r <= 30) notes.push(`RSI=${r}（売られ過ぎ）`);
    else if (r >= 70) notes.push(`RSI=${r}（買われ過ぎ）`);
    else notes.push(`RSI=${r}`);
  }

  if (latest?.bb) {
    const close = latest.close;
    if (close <= latest.bb.lower) notes.push(`BB下限付近`);
    else if (close >= latest.bb.upper) notes.push(`BB上限付近`);
  }

  if (latest?.macd) {
    const { macd, signal } = latest.macd;
    if (macd !== undefined && signal !== undefined) {
      if (macd < signal) notes.push(`MACDデッドクロス`);
      else if (macd > signal) notes.push(`MACDゴールデンクロス`);
    }
  }

  if (latest?.adx?.value >= 25) notes.push(`ADX${latest.adx.value}（トレンド強め）`);

  return notes.join('、') || '所見なし';
}