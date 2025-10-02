export const runtime = "nodejs";

export async function GET() {
  const BASE = process.env.INDICATORS_BASE_URL;
  if (!BASE) {
    return new Response(JSON.stringify({ ok: false, error: "INDICATORS_BASE_URL is not set" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
  try {
    // FastAPIの /health が無ければ /docs にHEAD
    const res = await fetch(`${BASE}/health`).catch(() => fetch(`${BASE}/docs`));
    return new Response(JSON.stringify({ ok: true, base: BASE, upstream_status: res.status }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (e:any) {
    return new Response(JSON.stringify({ ok: false, base: BASE, error: String(e?.message||e) }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }
}
