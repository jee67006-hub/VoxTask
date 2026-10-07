import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "Set GROQ_API_KEY in .env.local to enable Whisper transcription." }, { status: 503 });
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  const mode = form?.get("mode") ?? "accurate";
  const hints = form?.get("hints") ?? "";
  if (!(audio instanceof File) || audio.size === 0 || audio.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "Provide an audio file smaller than 25 MB." }, { status: 400 });
  }
  if (mode !== "live" && mode !== "accurate") return NextResponse.json({ error: "Choose live or accurate transcription." }, { status: 400 });
  if (typeof hints !== "string" || hints.length > 500) return NextResponse.json({ error: "Vocabulary hints must be under 500 characters." }, { status: 400 });
  const started = performance.now();
  try {
    const upstream = new FormData();
    upstream.set("file", audio, audio.name || "recording.webm");
    const model = mode === "accurate" ? "whisper-large-v3" : "whisper-large-v3-turbo";
    upstream.set("model", model);
    upstream.set("response_format", "json");
    upstream.set("language", "en");
    if (hints.trim()) upstream.set("prompt", hints.trim());
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: upstream, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return NextResponse.json({ error: response.status === 429 ? "Groq free-plan limit reached. Try again later." : `Groq transcription failed (${response.status}).` }, { status: response.status === 429 ? 429 : 502 });
    const data = await response.json();
    if (typeof data.text !== "string") throw new Error("Missing transcription");
    return NextResponse.json({ transcript: data.text, durationMs: Math.round(performance.now() - started), provider: model === "whisper-large-v3" ? "Groq Whisper Large V3" : "Groq Whisper Large V3 Turbo" });
  } catch {
    return NextResponse.json({ error: "Transcription failed. Try browser speech or type a transcript." }, { status: 502 });
  }
}
