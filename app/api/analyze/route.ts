// app/api/analyze/route.ts など
export const runtime = "nodejs";

const TIMEOUT_MS = 15_000 as const;
const ALLOWED_TF = ["M15", "H1", "H4"] as const;
type TF = (typeof ALLOWED_TF)[number];

type PresetName = "default" | "light" | "trend" | "mean_revert";

const PRESETS: Record<PresetName, any> = {
  default: {
    rsi: { period: 14 },
    macd: { fast: 12, slow: 26, signal: 9 },
    bb: { period: 20, stddev: 2 },
    sma: [{ period: 20 }, { period: 50 }],
    ema: [{ period: 20 }, { period: 50 }],
  },
  light: { rsi: { period: 14 } },
  trend: { sma: [{ period: 50 }, { period: 200 }], ema: [{ period: 20 }, { period: 50 }] },
  mean_revert: { bb: { period: 20, stddev: 2 }, rsi: { period: 14 } },
};

function corsHeaders() {
  // 必要に応じてオリジン固定推奨
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-bff-token",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

type AnalyzeBody = {
  instrument: string;
  tf: ("M15" | "H1" | "H4" | "D1")[]; // D1 は受け取っても内部で H4 へ丸める
  count?: number;
  indicators?: Record<string, any> | undefined;
  preset?: PresetName | undefined;
};

function normalizeTf(tfIn: AnalyzeBody["tf"]): TF[] {
  const mapped = (tfIn || []).map((t) => (t === "D1" ? "H4" : t)) as (TF | "D1")[];
  // 許可リストでフィルタ & 重複除去（順序維持）
  const seen = new Set<string>();
  const out: TF[] = [];
  for (const t of mapped) {
    if ((ALLOWED_TF as readonly string[]).includes(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t as TF);
    }
  }
  return out;
}

function mergeIndicators(presetName: PresetName | undefined, indicators: Record<string, any> | undefined) {
  const base = presetName ? PRESETS[presetName] ?? {} : {};
  // 浅いマージで十分（必要なら個別に深いマージを実装）
  return { ...base, ...(indicators || {}) };
}

function isValidInstrument(ins?: string) {
  return !!ins && /^[A-Z]{3}_[A-Z]{3}$/.test(ins);
}

export async function OPTIONS() {
  return new Response(null, { headers: corsHeaders() });
}

export async function POST(req: Request) {
  const BASE = process.env.INDICATORS_BASE_URL;
  if (!BASE) {
    return new Response(JSON.stringify({ ok: false, step: "env", error: "INDICATORS_BASE_URL is not set" }), {
      status: 500, headers: corsHeaders(),
    });
  }

  // BFF トークン検証（環境変数が未設定ならスキップ）
  const needToken = process.env.BFF_TOKEN;
  if (needToken) {
    const got = req.headers.get("x-bff-token");
    if (!got || got !== needToken) {
      return new Response(JSON.stringify({ ok: false, step: "auth", error: "unauthorized" }), {
        status: 401, headers: corsHeaders(),
      });
    }
  }

  let body: AnalyzeBody;
  try {
    body = (await req.json()) as AnalyzeBody;
  } catch {
    return new Response(JSON.stringify({ ok: false, step: "parse", error: "invalid JSON" }), {
      status: 400, headers: corsHeaders(),
    });
  }

  const { instrument, count = 240, indicators, preset } = body;
  const tf = normalizeTf(body.tf);

  if (!isValidInstrument(instrument) || tf.length === 0) {
    return new Response(JSON.stringify({ ok: false, step: "validate", error: "invalid instrument or tf" }), {
      status: 400, headers: corsHeaders(),
    });
  }

  const mergedIndicators = mergeIndicators(preset, indicators);

  try {
    // /v1/ensure
    const ensureRes = await withTimeout(
      fetch(`${BASE}/v1/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instrument, tf, count, indicators: mergedIndicators }),
      }),
      TIMEOUT_MS
    );
    if (!ensureRes.ok) {
      const t = await ensureRes.text();
      return new Response(JSON.stringify({ ok: false, step: "ensure", error: t }), {
        status: 502, headers: corsHeaders(),
      });
    }
    const ensureJson = await ensureRes.json();

    // H1 が含まれていれば最優先、なければ先頭
    const pick: TF = (tf.includes("H1" as TF) ? "H1" : tf[0]) as TF;
    const key: string | undefined = ensureJson?.cache_keys?.[pick];
    if (!key) {
      return new Response(JSON.stringify({ ok: false, step: "cache_key", error: "cache key not found" }), {
        status: 500, headers: corsHeaders(),
      });
    }

    // /v1/series
    const seriesRes = await withTimeout(fetch(`${BASE}/v1/series?key=${encodeURIComponent(key)}`), TIMEOUT_MS);
    if (!seriesRes.ok) {
      const t = await seriesRes.text();
      return new Response(JSON.stringify({ ok: false, step: "series", error: t }), {
        status: 502, headers: corsHeaders(),
      });
    }
    const series = await seriesRes.json();

    // 必要なら "notes" を生成して返す（最新バーから所見メモ）
    const notes = makeNotes(ensureJson?.latest);

    return new Response(JSON.stringify({ ok: true, latest: ensureJson?.latest, key, raw: series, notes }), {
      headers: corsHeaders(),
    });
  } catch (e: any) {
    const step = String(e?.message || e) === "timeout" ? "timeout" : "unknown";
    return new Response(JSON.stringify({ ok: false, step, error: String(e?.message || e) }), {
      status: 500, headers: corsHeaders(),
    });
  }
}

// --- おまけ: 直感的な所見メモ（UI向け; 無くても可） ---
function makeNotes(latest: any): string {
  if (!latest) return "";
  const notes: string[] = [];

  if (typeof latest?.rsi14 === "number") {
    if (latest.rsi14 >= 70) notes.push(`RSI高め(${latest.rsi14})`);
    else if (latest.rsi14 <= 30) notes.push(`RSI低め(${latest.rsi14})`);
  }

  if (latest?.bb && typeof latest.close === "number") {
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
  return notes.join("、") || "所見なし";
}
