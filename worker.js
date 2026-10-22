// Cloudflare Worker: perantara antara aplikasi kalori dan Gemini API.
// Secret yang dibutuhkan: GEMINI_API_KEY
// Variabel opsional: MODEL (default gemini-flash-latest), ALLOWED_ORIGIN (default *)

const PROMPT = `Kamu ahli gizi. Lihat foto makanan ini dan kenali tiap makanan yang terlihat.
Perkirakan porsi dalam gram, lalu kalori (kkal), protein, karbohidrat, dan lemak (gram) untuk porsi itu.
Utamakan makanan Indonesia bila cocok. Jika foto bukan makanan, kembalikan items kosong.
Balas HANYA JSON dengan bentuk:
{"items":[{"name":"","grams":0,"kcal":0,"protein":0,"carbs":0,"fat":0}],"notes":""}`;

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
    if (!env.GEMINI_API_KEY) return reply({ error: "Secret GEMINI_API_KEY belum diisi" }, 500);

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

    const model = env.MODEL || "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mime || "image/jpeg", data: image } },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });

    if (!r.ok) return reply({ error: "Gemini menolak permintaan", status: r.status }, 502);

    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    try {
      return reply(JSON.parse(text));
    } catch {
      return reply({ error: "Respons AI tidak bisa dibaca" }, 502);
    }
  },
};
