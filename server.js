// Synthear AI — backend (no npm packages needed, Node 18+)
// The API key lives ONLY here (environment variable). It is never sent to the browser.
//
// Run:   export GROQ_API_KEY="your_key_here"
//        node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const KEY = process.env.GROQ_API_KEY;
const PORT = process.env.PORT || 8080;
const UPSTREAM = "https://api.groq.com/openai/v1";
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT || 20); // chat requests / minute / IP

if (!KEY) {
  console.error('\nAPI key not set. Run this first:\n  export GROQ_API_KEY="your_key_here"\n');
  process.exit(1);
}

/* ---------------- Prompts (kept on the server) ---------------- */
const PERSONA =
  "You are Synthear AI, a smart, friendly AI assistant created by Mr. Dost Kumar. " +
  "If asked who made you or what you are, say you are Synthear AI made by Mr. Dost Kumar; do not name any underlying model, company or API. " +
  "Reply in the same language the user writes in (English, Urdu, Roman Urdu, Sindhi, Hindi, etc.). Use Markdown for formatting.";
const CODER =
  " You are in CODER mode: an expert senior software engineer. Write clean, correct, working code in fenced code blocks with a language tag. Briefly explain the approach and mention edge cases.";
const TOOLS = {
  translate: "TOOL: Translator. Translate the user's text into the language they ask for (default: English if the text is not English, otherwise Urdu). Output the translation first, then one short note only if needed.",
  summarize: "TOOL: Summarizer. Summarize the user's text into short bullet points and a one-line TL;DR.",
  rewrite: "TOOL: Writing improver. Rewrite the user's text to be clearer and more professional, keeping the meaning. Show the improved version first.",
  explain: "TOOL: Explain the user's topic in very simple words with a short example, as for a beginner.",
  math: "TOOL: Math solver. Solve step by step, show formulas, and give the final answer clearly.",
  email: "TOOL: Email writer. Write a ready-to-send email (Subject + body) from the user's rough idea.",
  debug: "TOOL: Code debugger. Find the bugs in the user's code, explain each one, and give the corrected full code.",
  quiz: "TOOL: Quiz maker. Create 5 multiple-choice questions on the topic with the answers at the end.",
};

/* ---------------- Models (loaded live from your account) ---------------- */
const NOT_CHAT = /whisper|tts|orpheus|playai|guard|safeguard|embed|moderation/i;
const NAMES = {
  "llama-3.1-8b-instant": "Llama 3.1 8B · Fast",
  "llama-3.3-70b-versatile": "Llama 3.3 70B",
  "openai/gpt-oss-120b": "GPT-OSS 120B",
  "openai/gpt-oss-20b": "GPT-OSS 20B",
};
const PREFERRED = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "llama-3.1-8b-instant"];
const nice = (id) =>
  NAMES[id] ||
  id.split("/").pop().replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/(\d)b\b/gi, "$1B");

let cache = { t: 0, list: [] };
async function getModels() {
  if (cache.list.length && Date.now() - cache.t < 10 * 60 * 1000) return cache.list;
  try {
    const r = await fetch(UPSTREAM + "/models", { headers: { Authorization: "Bearer " + KEY } });
    if (!r.ok) throw new Error("status " + r.status);
    const j = await r.json();
    const list = j.data
      .map((m) => m.id)
      .filter((id) => !NOT_CHAT.test(id))
      .sort()
      .map((id) => ({ id, name: nice(id) }));
    if (list.length) cache = { t: Date.now(), list };
  } catch (e) {
    console.error("[models]", e.message);
    if (!cache.list.length)
      cache = { t: Date.now() - 9 * 60 * 1000, list: Object.keys(NAMES).map((id) => ({ id, name: NAMES[id] })) };
  }
  return cache.list;
}

/* ---------------- Helpers ---------------- */
const hits = new Map();
setInterval(() => { const c = Date.now() - 60000; for (const [k, v] of hits) { const f = v.filter((t) => t > c); f.length ? hits.set(k, f) : hits.delete(k); } }, 60000).unref();
function limited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => t > now - 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_MIN;
}
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
function readBody(req, max = 300000) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > max) { reject(new Error("too big")); req.destroy(); } });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}
async function wiki(q) {
  try {
    const url =
      "https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrlimit=4&prop=extracts|info&inprop=url&exintro=1&explaintext=1&exchars=900&format=json&gsrsearch=" +
      encodeURIComponent(q.slice(0, 200));
    const j = await (await fetch(url)).json();
    const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
    return pages.map((p, i) => `[${i + 1}] ${p.title} (${p.fullurl})\n${p.extract}`).join("\n\n");
  } catch { return ""; }
}

/* ---------------- Chat endpoint ---------------- */
async function handleChat(req, res) {
  if (limited(clientIp(req))) return json(res, 429, { error: "Too many messages. Please wait a minute and try again." });

  let p;
  try { p = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Bad request." }); }

  const models = await getModels();
  const ids = models.map((m) => m.id);
  const model = ids.includes(p.model) ? p.model : ids[0];

  const messages = (Array.isArray(p.messages) ? p.messages : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 30000) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return json(res, 400, { error: "Bad request." });

  let sys = PERSONA;
  if (p.mode === "coder") sys += CODER;
  if (p.mode === "tools" && TOOLS[p.tool]) sys += "\n" + TOOLS[p.tool];
  if (p.search && !/compound/i.test(model)) {
    const ctx = await wiki(messages[messages.length - 1].content);
    sys += ctx
      ? "\n\nThe user enabled web search. Use this context when relevant and mention the source title:\n" + ctx
      : "\n\nThe user enabled web search but nothing was found; answer from your own knowledge and say so.";
  }

  const temperature = Math.min(1.5, Math.max(0, Number(p.temperature ?? 0.7)));
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  let up;
  try {
    up = await fetch(UPSTREAM + "/chat/completions", {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
      body: JSON.stringify({ model, stream: true, temperature, max_tokens: 8192, messages: [{ role: "system", content: sys }, ...messages] }),
    });
  } catch (e) {
    if (e.name === "AbortError") return;
    console.error("[chat] network", e.message);
    return json(res, 502, { error: "Could not reach the AI service. Please try again." });
  }

  if (!up.ok) {
    console.error("[chat]", model, up.status, (await up.text()).slice(0, 300)); // details stay in your terminal only
    const msg = up.status === 429
      ? "This model is busy right now. Please wait a little or choose another model."
      : "This model is not available right now. Please choose another model.";
    return json(res, up.status === 429 ? 429 : 502, { error: msg });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const stream = Readable.fromWeb(up.body);
  stream.on("error", () => res.end());
  stream.pipe(res);
}

/* ---------------- HTTP server ---------------- */
const INDEX = path.join(__dirname, "public", "index.html");
http
  .createServer(async (req, res) => {
    try {
      const url = req.url.split("?")[0];
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return fs.createReadStream(INDEX).pipe(res);
      }
      if (req.method === "GET" && url === "/api/models") {
        const list = await getModels();
        const def = PREFERRED.find((id) => list.some((m) => m.id === id)) || list[0]?.id;
        return json(res, 200, { models: list, default: def });
      }
      if (req.method === "POST" && url === "/api/chat") return await handleChat(req, res);
      json(res, 404, { error: "Not found" });
    } catch (e) {
      console.error("[server]", e.message);
      if (!res.headersSent) json(res, 500, { error: "Server error." }); else res.end();
    }
  })
  .listen(PORT, "0.0.0.0", async () => {
    console.log(`\nSynthear AI is running on port ${PORT}`);
    const m = await getModels();
    console.log(`Models available: ${m.length}`);
    m.forEach((x) => console.log("  -", x.id));
  });
