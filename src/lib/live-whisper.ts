type Result = { transcript: string; durationMs: number };

/** Sends complete recording snapshots in order. MediaRecorder timeslices alone are not standalone WebM files. */
export class LiveWhisperSession {
  private chunks: Blob[] = [];
  private version = 0;
  private uploadedVersion = 0;
  private enabled = false;
  private finished = false;
  private canceled = false;
  private complete = false;
  private pending: Promise<void> | null = null;

  constructor(
    private upload: (audio: Blob) => Promise<Result>,
    private onTranscript: (text: string, durationMs: number) => void,
    private onError: (message: string) => void,
    private onFinished: () => void,
  ) {}

  enable() {
    if (this.canceled) return;
    this.enabled = true;
    this.drain();
  }

  addChunk(chunk: Blob) {
    if (this.canceled || !chunk.size) return;
    this.chunks.push(chunk);
    this.version++;
    this.drain();
  }

  finish() {
    if (this.canceled) return;
    this.finished = true;
    this.drain();
  }

  cancel() { this.canceled = true; }

  async whenIdle() {
    while (this.pending) await this.pending;
  }

  private drain() {
    if (!this.enabled || this.canceled || this.pending || this.complete) return;
    if (this.version === this.uploadedVersion) {
      if (this.finished) this.finishOnce();
      return;
    }
    const snapshotVersion = this.version;
    const recording = new Blob(this.chunks, { type: this.chunks[0].type || "audio/webm" });
    this.pending = this.upload(recording)
      .then(result => {
        if (this.canceled) return;
        this.uploadedVersion = snapshotVersion;
        this.onTranscript(result.transcript, result.durationMs);
      })
      .catch(error => {
        if (this.canceled) return;
        this.enabled = false;
        this.onError(error instanceof Error ? error.message : "Live transcription failed.");
      })
      .finally(() => {
        this.pending = null;
        this.drain();
      });
  }

  private finishOnce() {
    if (this.complete) return;
    this.complete = true;
    this.onFinished();
  }
}
