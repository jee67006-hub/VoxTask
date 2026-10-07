import { describe, expect, it, vi } from "vitest";
import { LiveWhisperSession } from "./live-whisper";

describe("LiveWhisperSession", () => {
  it("sends recorded audio after browser speech fails and updates the transcript", async () => {
    const upload = vi.fn(async () => ({ transcript: "Call Adarsh tomorrow.", durationMs: 500 }));
    const onTranscript = vi.fn();
    const session = new LiveWhisperSession(upload, onTranscript, vi.fn(), vi.fn());
    session.addChunk(new Blob(["recorded audio"]));
    expect(upload).not.toHaveBeenCalled();
    session.enable();
    await session.whenIdle();
    expect(upload).toHaveBeenCalledOnce();
    expect(onTranscript).toHaveBeenCalledWith("Call Adarsh tomorrow.", 500);
  });

  it("uploads the latest full recording when stopped during an in-flight request", async () => {
    let resolveFirst!: (value: { transcript: string; durationMs: number }) => void;
    const upload = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; })).mockResolvedValue({ transcript: "Final transcript", durationMs: 600 });
    const onTranscript = vi.fn();
    const onFinished = vi.fn();
    const session = new LiveWhisperSession(upload, onTranscript, vi.fn(), onFinished);
    session.enable();
    session.addChunk(new Blob(["first"]));
    session.addChunk(new Blob([" second"]));
    session.finish();
    resolveFirst({ transcript: "Partial transcript", durationMs: 400 });
    await session.whenIdle();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(onTranscript).toHaveBeenLastCalledWith("Final transcript", 600);
    expect(onFinished).toHaveBeenCalledOnce();
  });
});
