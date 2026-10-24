// Cloudflare Worker: perantara antara aplikasi kalori dan AI.
// AI utama: Gemini Flash-Lite. Cadangan: Cloudflare Workers AI (Llama 3.2 Vision) lewat binding "AI".
// Secret yang dibutuhkan: GEMINI_API_KEY
// Variabel opsional: MODEL (default gemini-flash-lite-latest), ALLOWED_ORIGIN (default *)

const PROMPT = `Kamu ahli gizi. Lihat foto makanan ini dan kenali tiap makanan yang terlihat.
Perkirakan porsi dalam gram, lalu kalori (kkal), protein, karbohidrat, dan lemak (gram) untuk porsi itu.
Utamakan makanan Indonesia bila cocok. Jika foto bukan makanan, kembalikan items kosong.
Balas HANYA JSON dengan bentuk:
{"items":[{"name":"","grams":0,"kcal":0,"protein":0,"carbs":0,"fat":0}],"notes":""}`;

const CF_PROMPT = `${PROMPT}
Contoh:
{"items":[{"name":"Nasi putih","grams":150,"kcal":195,"protein":4,"carbs":42,"fat":0.4}],"notes":""}
Jangan tulis teks lain selain JSON.`;

const CF_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const RETRY_STATUS = [500, 503, 504];
const GEMINI_TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Ambil daftar makanan dari teks/objek, toleran terhadap JSON yang terpotong.
function parseItems(raw) {
  if (raw && typeof raw === "object") return Array.isArray(raw.items) ? raw : null;
  const text = String(raw || "");
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const d = JSON.parse(m[0]);
      if (Array.isArray(d.items)) return d;
    } catch {}
  }
  const found = text.match(/\{[^{}]*"name"[^{}]*\}/g) || [];
  const items = [];
  for (const f of found) {
    try {
      items.push(JSON.parse(f));
    } catch {}
  }
  return items.length ? { items, notes: "" } : null;
}

async function askGemini(env, image, mime) {
  const model = env.MODEL || "gemini-flash-lite-latest";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mime || "image/jpeg", data: image } },
        ],
      },
    ],
    generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
  });

  let r = null;
  let timedOut = false;
  for (let i = 0; i < 2; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), GEMINI_TIMEOUT_MS);
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: payload,
        signal: ctl.signal,
      });
    } catch (e) {
      r = null;
      timedOut = e?.name === "AbortError";
    } finally {
      clearTimeout(timer);
    }
    if (!r || r.ok || !RETRY_STATUS.includes(r.status)) break;
    if (i < 1) await sleep(1000);
  }

  if (!r) {
    return {
      ok: false,
      status: 0,
      detail: timedOut ? "Gemini terlalu lama menjawab" : "Tidak bisa menghubungi Gemini",
    };
  }

  if (!r.ok) {
    let detail = "";
    try {
      const e = await r.json();
      detail = String(e?.error?.message || "").slice(0, 160);
    } catch {}
    if (r.status === 524 && !detail) detail = "Gemini terlalu lama menjawab (timeout)";
    return { ok: false, status: r.status, detail };
  }

  try {
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = parseItems(text);
    if (!parsed) throw new Error("bentuk salah");
    return { ok: true, data: parsed };
  } catch {
    return { ok: false, status: 502, detail: "Respons Gemini tidak bisa dibaca" };
  }
}

async function askCloudflare(env, image, mime) {
  const inputs = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CF_PROMPT },
          { type: "image_url", image_url: { url: `data:${mime || "image/jpeg"};base64,${image}` } },
        ],
      },
    ],
    max_tokens: 900,
    temperature: 0.2,
  };

  let res;
  try {
    try {
      res = await env.AI.run(CF_MODEL, inputs);
    } catch (e) {
      // Pertama kali dipakai, model meminta persetujuan lisensi Meta.
      if (/agree/i.test(String(e?.message))) {
        await env.AI.run(CF_MODEL, { prompt: "agree" });
        res = await env.AI.run(CF_MODEL, inputs);
      } else {
        throw e;
      }
    }
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 160) };
  }

  const raw = typeof res === "string" ? res : res?.response ?? "";
  const parsed = parseItems(raw);
  if (parsed) return { ok: true, data: parsed };
  const snippet = (typeof raw === "string" ? raw : JSON.stringify(raw)).replace(/\s+/g, " ").slice(0, 80);
  return { ok: false, detail: `Respons AI cadangan tidak bisa dibaca: ${snippet || "kosong"}` };
}

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return reply({ error: "Gunakan POST" }, 405);

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: "Body bukan JSON yang valid" }, 400);
    }

    const { image, mime } = body;
    if (!image || typeof image !== "string" || image.length > 4000000) {
      return reply({ error: "Gambar tidak ada atau terlalu besar" }, 400);
    }

    // 1) Gemini dulu (lebih akurat)
    let g = { ok: false, status: 0, detail: "Secret GEMINI_API_KEY belum diisi" };
    if (env.GEMINI_API_KEY) g = await askGemini(env, image, mime);
    if (g.ok) return reply({ ...g.data, source: "gemini" });

    // 2) Cadangan: Cloudflare Workers AI
    if (env.AI) {
      const c = await askCloudflare(env, image, mime);
      if (c.ok) {
        return reply({ ...c.data, source: "cloudflare", fallbackReason: g.status, fallbackDetail: g.detail || "" });
      }
      return reply(
        {
          error: "Semua AI gagal",
          status: g.status,
          detail: `Gemini: ${g.detail || g.status}. Cadangan: ${c.detail}`.slice(0, 260),
        },
        502
      );
    }

    return reply({ error: "Gemini menolak permintaan", status: g.status, detail: g.detail }, 502);
  },
};
