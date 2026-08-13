import Anthropic from "@anthropic-ai/sdk";
import Database from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const publicDir = `${import.meta.dir}/public`;

// ---- Database: persist conversations + messages -------------------------
const dbPath = process.env.DATABASE_URL || `${import.meta.dir}/data/app.db`;
mkdirSync(dirname(dbPath), { recursive: true }); // ensure the data dir exists
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL DEFAULT 'New chat',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---- AI broker ----------------------------------------------------------
const aiEnabled = !!process.env.SANTAI_AI_TOKEN;
const ai = new Anthropic({
  baseURL: process.env.SANTAI_AI_BASE_URL,
  apiKey: process.env.SANTAI_AI_TOKEN || "placeholder",
});
const MODEL = "anthropic-claude-bedrock4.5-haiku";
const SYSTEM_PROMPT =
  "You are a friendly, concise assistant. Answer clearly and helpfully. " +
  "Use Markdown for structure (lists, bold, code blocks) when it aids readability.";

// ---- Helpers ------------------------------------------------------------
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function listConversations() {
  return db
    .query(
      `SELECT c.id, c.title, c.created_at,
              (SELECT content FROM messages m WHERE m.conversation_id = c.id
               ORDER BY m.id DESC LIMIT 1) AS preview
       FROM conversations c ORDER BY c.id DESC`
    )
    .all();
}

function getMessages(cid: number) {
  return db
    .query(
      `SELECT role, content FROM messages
       WHERE conversation_id = ? ORDER BY id ASC`
    )
    .all(cid);
}

// ---- Server -------------------------------------------------------------
export default {
  port: process.env.PORT || 3000,
  async fetch(req: Request) {
    const { pathname } = new URL(req.url);

    // --- API ---
    if (pathname === "/api/conversations" && req.method === "GET") {
      return json({ conversations: listConversations() });
    }

    if (pathname === "/api/conversations" && req.method === "POST") {
      const { lastInsertRowid } = db
        .query("INSERT INTO conversations DEFAULT VALUES")
        .run();
      return json({ id: Number(lastInsertRowid) });
    }

    const convMatch = pathname.match(/^\/api\/conversations\/(\d+)$/);
    if (convMatch) {
      const cid = Number(convMatch[1]);
      if (req.method === "GET") {
        return json({ messages: getMessages(cid) });
      }
      if (req.method === "DELETE") {
        db.query("DELETE FROM messages WHERE conversation_id = ?").run(cid);
        db.query("DELETE FROM conversations WHERE id = ?").run(cid);
        return json({ ok: true });
      }
    }

    if (pathname === "/api/chat" && req.method === "POST") {
      try {
        const { conversationId, message } = await req.json();
        if (!message?.trim()) return json({ error: "Empty message" }, 400);

        let cid = Number(conversationId);
        if (!cid) {
          const { lastInsertRowid } = db
            .query("INSERT INTO conversations DEFAULT VALUES")
            .run();
          cid = Number(lastInsertRowid);
        }

        // Persist the user message.
        db.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)"
        ).run(cid, message);

        // Title the conversation from its first user message.
        const count = db
          .query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
          .get(cid) as { n: number };
        if (count.n === 1) {
          const title =
            message.trim().slice(0, 48) + (message.trim().length > 48 ? "…" : "");
          db.query("UPDATE conversations SET title = ? WHERE id = ?").run(
            title,
            cid
          );
        }

        if (!aiEnabled) {
          const note =
            "⚠️ AI isn't configured in this environment (no SANTAI_AI_TOKEN). " +
            "Deploy the app and it will respond for real.";
          db.query(
            "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
          ).run(cid, note);
          return json({ conversationId: cid, reply: note });
        }

        // Build history for the model.
        const history = getMessages(cid) as { role: string; content: string }[];
        const msg = await ai.messages.create({
          model: MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: history.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
        });
        const reply = msg.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim();

        db.query(
          "INSERT INTO messages (conversation_id, role, content) VALUES (?, 'assistant', ?)"
        ).run(cid, reply);

        return json({ conversationId: cid, reply });
      } catch (err) {
        console.error("chat error:", err);
        return json({ error: "The assistant failed to respond." }, 500);
      }
    }

    // --- Static files ---
    const filePath = `${publicDir}${pathname === "/" ? "/index.html" : pathname}`;
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);

    return new Response("Not found", { status: 404 });
  },
};
