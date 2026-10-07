import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.GROQ_API_KEY; });

describe("transcription modes", () => {
  it("uses the accurate model and spelling hints for the final recording", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const upstream = vi.fn(async (_url: string, options: RequestInit) => {
      const body = options.body as FormData;
      expect(body.get("model")).toBe("whisper-large-v3");
      expect(body.get("prompt")).toBe("Adarsh, PPT");
      expect(body.get("language")).toBe("en");
      return new Response(JSON.stringify({ text: "Call Adarsh about the PPT." }), { status: 200 });
    });
    vi.stubGlobal("fetch", upstream);
    const form = new FormData();
    form.set("audio", new File(["test audio"], "sample.wav", { type: "audio/wav" }));
    form.set("mode", "accurate");
    form.set("hints", "Adarsh, PPT");
    const request = new NextRequest("http://localhost/api/transcribe", { method: "POST", body: form });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transcript: "Call Adarsh about the PPT.", provider: "Groq Whisper Large V3" });
  });
});
