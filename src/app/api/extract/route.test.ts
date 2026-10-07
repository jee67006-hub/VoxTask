import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

afterEach(() => { vi.unstubAllGlobals(); delete process.env.GROQ_API_KEY; });

describe("task extraction", () => {
  it("retries an invalid model response and preserves spoken progress", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const upstream = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "not-json" } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [
        { title: "Finish presentation", description: null, priority: "medium", status: "in_progress", dueDate: null, dueDateText: null, dueTime: null, dueTimeText: null, dependencies: [], sourceText: "started the presentation" },
        { title: "Call Adarsh", description: null, priority: "medium", status: "done", dueDate: null, dueDateText: null, dueTime: null, dueTimeText: null, dependencies: [], sourceText: "already called Adarsh" },
      ] }) } }] }), { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const request = new NextRequest("http://localhost/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "I started the presentation. I already called Adarsh.", currentDate: "2026-10-07", timeZone: "Asia/Kolkata" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect((await response.json()).tasks.map((task: { status: string }) => task.status)).toEqual(["in_progress", "done"]);
  });
});
