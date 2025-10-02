// app/api/analyze/route.ts
import { NextRequest, NextResponse } from "next/server";

const BASE = process.env.INDICATORS_BASE_URL!;
const TIMEOUT_MS = 8000;

type AnalyzeBody = {
  instrument: string;          // "USD_JPY"
  tf: ("M15"|"H1"|"D1")[];     // ["M15","H1","D1"]
  count?: number;              // 240 など
  indicators?: any;            // 省略時はサーバ側デフォルトでもOK
};

async function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

export async function POST(req: NextRequest) {
  try {
    const { instrument, tf, count = 240, indicators } = (await req.json()) as AnalyzeBody;

    // 1) ensure: 指標計算＆キャッシュキー取得
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
      return NextResponse.json({ ok: false, step: "ensure", error: t }, { status: 502 });
    }
    const ensureJson = await ensureRes.json();

    // 2) series: 可視化・所見用に1つのTFだけ引く（例：H1を優先）
    const tfPick = tf.includes("H1") ? "H1" : tf[0];
    const key = ensureJson.cache_keys[tfPick];
    const seriesRes = await withTimeout(fetch(`${BASE}/v1/series?key=${encodeURIComponent(key)}`), TIMEOUT_MS);
    if (!seriesRes.ok) {
      const t = await seriesRes.text();
      return NextResponse.json({ ok: false, step: "series", error: t }, { status: 502 });
    }
    const series = await seriesRes.json();

    // 3) 軽い所見を生成（BFF側のルールベース。GPT要約は別ルートでもOK）
    const view = summarize(series);

    return NextResponse.json({ ok: true, latest: ensureJson.latest, key, view, raw: series });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

// 超軽量ルール：RSI/BB/MACD から所見文を作る
function summarize(series: any) {
  const n = series?.ohlcv?.time?.length ?? 0;
  if (n < 30) return "データ本数が少ないため、参考所見のみ。";

  const lastIdx = n - 1;
  const close = series.ohlcv.close[lastIdx];
  const rsiArr = series?.indicators?.rsi as number[] | undefined;
  const bb = series?.indicators?.bb;
  const macd = series?.indicators?.macd;

  const bits: string[] = [];
  if (rsiArr) {
    const rsi = rsiArr[lastIdx];
    if (rsi >= 70) bits.push(`RSI=${rsi.toFixed(1)}（買われ過ぎ）`);
    else if (rsi <= 30) bits.push(`RSI=${rsi.toFixed(1)}（売られ過ぎ）`);
    else bits.push(`RSI=${rsi?.toFixed(1)}`);
  }
  if (bb) {
    const mid = bb.mid[lastIdx], up = bb.upper[lastIdx], lo = bb.lower[lastIdx];
    if (close >= up) bits.push("上バンド到達/エクスパンション警戒");
    else if (close <= lo) bits.push("下バンド到達/エクスパンション警戒");
    else if (mid) bits.push(`BBミドル=${mid.toFixed(3)}`);
  }
  if (macd) {
    const hist = macd.hist[lastIdx];
    if (hist !== null && hist !== undefined) {
      bits.push(`MACDヒストグラム=${(+hist).toFixed(3)}（${hist > 0 ? "強気" : "弱気"}）`);
    }
  }
  return `終値=${close}\n${bits.join(" / ")}`;
}
