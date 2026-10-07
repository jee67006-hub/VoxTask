import { NextRequest, NextResponse } from "next/server";
import { extractionJsonSchema, normalizeTasks } from "../../../lib/tasks";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "Set GROQ_API_KEY in .env.local to enable AI extraction." }, { status: 503 });
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 }); }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const input = body as Record<string, unknown>;
  const transcript = typeof input.transcript === "string" ? input.transcript.trim() : "";
  const currentDate = typeof input.currentDate === "string" ? input.currentDate : "";
  const timeZone = typeof input.timeZone === "string" ? input.timeZone : "";
  if (!transcript || transcript.length > 10000 || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate) || timeZone.length > 100) {
    return NextResponse.json({ error: "Provide a transcript (up to 10,000 characters) and local date." }, { status: 400 });
  }

  const started = performance.now();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b",
        temperature: 0,
        messages: [
          { role: "system", content: `Extract personal tasks and their current state from a spoken brain dump. Today is ${currentDate} in ${timeZone || "the user's local timezone"}. Return zero tasks if there is no action. Include planned, in-progress and completed actions when the speaker mentions them; split distinct actions, INCLUDING optional actions introduced by "maybe". Set status to done for explicit completion ("I already called Adarsh"), in_progress for explicit ongoing work ("I started the presentation"), and todo for planned or unclear work. SourceText must be an EXACT continuous substring of the transcript. Never invent a deadline; use null if unknown or ambiguous. dueDateText and dueTimeText must each be exact continuous phrases from the transcript; they preserve spoken wording. A date at the start of a sentence applies to each coordinated action in that sentence unless a later date overrides it. A relative time constraint such as "before class" applies only to its nearby action unless explicitly repeated. For example, in "Tomorrow before class finish the presentation, then call Adarsh", BOTH tasks are due tomorrow but only the first has dueTimeText "before class". For "by Friday evening", set dueDateText to "Friday" and dueTimeText to "evening". For "this weekend", use dueDateText "this weekend" and dueDate null because it is a date range. Normalize clear relative dates to YYYY-MM-DD. Use dueTime HH:mm only for explicit clock times; for "before class" or "evening", dueTime must be null and dueTimeText keeps the phrase. Priority high only for explicit urgency or imminent deadlines; low for optional language; otherwise medium. Dependencies should contain other extracted task titles only when clearly stated. Do not emit numerical confidence scores or a confirmation flag; the server derives review needs from the extracted evidence.` },
          { role: "user", content: transcript },
        ],
        response_format: { type: "json_schema", json_schema: { name: "voxtask_tasks", strict: true, schema: extractionJsonSchema } },
      }),
      signal: AbortSignal.timeout(20000),
    });
      if (!response.ok) return NextResponse.json({ error: response.status === 429 ? "Groq free-plan limit reached. Try again later." : `Groq extraction failed (${response.status}).` }, { status: response.status === 429 ? 429 : 502 });
      try {
        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("No model response");
        const raw = JSON.parse(content);
        const tasks = normalizeTasks(raw, transcript, currentDate);
        if (raw.tasks?.length && !tasks.length) throw new Error("No tasks matched the transcript");
        return NextResponse.json({ tasks, durationMs: Math.round(performance.now() - started), model: process.env.GROQ_TEXT_MODEL || "openai/gpt-oss-20b" });
      } catch {
        if (attempt === 1) return NextResponse.json({ error: "Could not validate the AI response after two attempts. Please retry or edit the transcript." }, { status: 502 });
      }
    }
  } catch {
    return NextResponse.json({ error: "AI extraction could not be reached. Please retry." }, { status: 502 });
  }
  return NextResponse.json({ error: "Task extraction failed. Please retry." }, { status: 502 });
}
