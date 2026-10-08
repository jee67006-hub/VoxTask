"use client";

import { useEffect, useRef, useState } from "react";
import type { Task } from "@/lib/tasks";
import { LiveWhisperSession } from "@/lib/live-whisper";
import { calculateCalibration, calibratedConfidence, parseReviews, reviewedFields, CALIBRATION_VERSION, MIN_REVIEWED_TASKS, type Review } from "@/lib/calibration";
import RecordOrb from "./RecordOrb";

type SpeechResult = { isFinal: boolean; 0: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechRecognitionLike = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: SpeechEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void;
};
type SpeechWindow = Window & { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
type State = "ready" | "listening" | "stopping" | "transcribing" | "processing" | "complete" | "error";

const sample = "Tomorrow finish the presentation before class, call Adarsh in the evening and maybe buy an SSD this weekend.";
const emptyMetrics = { recordingMs: 0, transcriptionMs: 0, extractionMs: 0 };
const reviewStorageKey = "voxtask-calibration-reviews-v1";
const historyStorageKey = "voxtask-task-history-v1";
type HistoryTask = Task & { savedAt: string };

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatMs(ms: number) { return ms ? `${(ms / 1000).toFixed(2)} s` : "—"; }
function formatConfidence(value: number | null) { return value === null ? "pending" : `${Math.round(value * 100)}%`; }

async function requestWhisper(recording: Blob, mode: "live" | "accurate", hints: string) {
  const form = new FormData();
  form.set("audio", recording, recording.type.includes("mp4") ? "recording.mp4" : "recording.webm");
  form.set("mode", mode);
  form.set("hints", hints);
  const response = await fetch("/api/transcribe", { method: "POST", body: form });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Transcription failed.");
  return data as { transcript: string; durationMs: number; provider: string };
}

export default function Page() {
  const [status, setStatus] = useState<State>("ready");
  const [message, setMessage] = useState("");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [historyTasks, setHistoryTasks] = useState<HistoryTask[]>([]);
  const [introDone, setIntroDone] = useState(false);
  const [dockVisible, setDockVisible] = useState(false);
  const introDoneRef = useRef(false);
  const dockVisibilityRef = useRef(false);
  const [savedCurrentResult, setSavedCurrentResult] = useState(false);
  const [predictedTasks, setPredictedTasks] = useState<Task[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [extractionModel, setExtractionModel] = useState("openai/gpt-oss-20b");
  const [reviewKey, setReviewKey] = useState("");
  const [missedTasks, setMissedTasks] = useState(0);
  const [reviewMessage, setReviewMessage] = useState("");
  const [provider, setProvider] = useState("Browser Speech Recognition");
  const [vocabularyHints, setVocabularyHints] = useState("Adarsh, hackathon, PPT, SSD");
  const [liveDraft, setLiveDraft] = useState("");
  const [finalV3, setFinalV3] = useState("");
  const [inputDevice, setInputDevice] = useState("Not selected yet");
  const [selectedDeviceId, setSelectedDeviceId] = useState("default");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [elapsed, setElapsed] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const audio = useRef<Blob | null>(null);
  const started = useRef(0);
  const listening = useRef(false);
  const finalTranscript = useRef("");
  const recordingUrlRef = useRef<string | null>(null);
  const liveWhisper = useRef<LiveWhisperSession | null>(null);
  const liveMode = useRef(false);
  const browserSpeechFailed = useRef(false);

  useEffect(() => {
    try { setReviews(parseReviews(JSON.parse(localStorage.getItem(reviewStorageKey) || "[]"))); }
    catch { setReviews([]); }
    try {
      const parsed = JSON.parse(localStorage.getItem(historyStorageKey) || "[]");
      if (Array.isArray(parsed)) setHistoryTasks(parsed.filter(item => item && typeof item.id === "string" && typeof item.title === "string" && typeof item.savedAt === "string"));
    } catch { setHistoryTasks([]); }
  }, []);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const progress = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.9)));
        document.documentElement.style.setProperty("--dock-progress", String(progress));
        const visible = introDoneRef.current && progress > 0.85;
        if (dockVisibilityRef.current !== visible) {
          dockVisibilityRef.current = visible;
          setDockVisible(visible);
        }
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    if (status !== "listening") return;
    const timer = setInterval(() => setElapsed(performance.now() - started.current), 100);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => () => {
    listening.current = false;
    liveWhisper.current?.cancel();
    recognition.current?.stop();
    stream.current?.getTracks().forEach(track => track.stop());
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
  }, []);

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const updateDevices = async () => {
      try {
        const available = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId !== "default");
        setDevices(available);
        setSelectedDeviceId(current => current === "default" || available.some(device => device.deviceId === current) ? current : "default");
      } catch { /* Recording still works with the default device. */ }
    };
    void updateDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", updateDevices);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", updateDevices);
  }, []);

  async function refreshDevices() {
    setMessage("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone selection is unavailable in this browser.");
      const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      permissionStream.getTracks().forEach(track => track.stop());
      const available = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "audioinput" && device.deviceId !== "default");
      setDevices(available);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not list microphones.");
    }
  }

  async function startRecording() {
    setMessage(""); setTasks([]); setPredictedTasks([]); setReviewKey(""); setMetrics(emptyMetrics); setElapsed(0); setInterim("");
    setTranscript(""); setLiveDraft(""); setFinalV3(""); finalTranscript.current = ""; audio.current = null; setHasAudio(false);
    if (recordingUrlRef.current) URL.revokeObjectURL(recordingUrlRef.current);
    recordingUrlRef.current = null; setRecordingUrl(null);
    liveWhisper.current?.cancel(); liveMode.current = false; browserSpeechFailed.current = false;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording is unavailable in this browser.");
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: selectedDeviceId === "default" ? true : { deviceId: { exact: selectedDeviceId } } });
      setInputDevice(stream.current.getAudioTracks()[0]?.label || "Default microphone (name unavailable)");
      chunks.current = [];
      const liveSession = new LiveWhisperSession(
        recording => requestWhisper(recording, "live", vocabularyHints),
        (text, durationMs) => {
          if (text.trim()) { setTranscript(text.trim()); setLiveDraft(text.trim()); finalTranscript.current = text.trim(); }
          setMetrics(previous => ({ ...previous, transcriptionMs: previous.transcriptionMs + durationMs }));
        },
        error => { setMessage(`Live updates paused: ${error}. Final accuracy pass will still run after Stop.`); },
        () => {},
      );
      liveWhisper.current = liveSession;
      const recording = new MediaRecorder(stream.current);
      recorder.current = recording;
      recording.ondataavailable = event => { if (event.data.size) { chunks.current.push(event.data); liveSession.addChunk(event.data); } };
      recording.onstop = async () => {
        audio.current = new Blob(chunks.current, { type: recording.mimeType || "audio/webm" });
        setHasAudio(audio.current.size > 0);
        if (audio.current.size) { recordingUrlRef.current = URL.createObjectURL(audio.current); setRecordingUrl(recordingUrlRef.current); }
        stream.current?.getTracks().forEach(track => track.stop());
        setStatus("transcribing");
        if (liveMode.current) { liveSession.finish(); await liveSession.whenIdle(); }
        try {
          if (!audio.current.size) throw new Error("The recording is empty. Try another input device.");
          const final = await requestWhisper(audio.current, "accurate", vocabularyHints);
          if (liveWhisper.current !== liveSession) return;
          setFinalV3(final.transcript.trim()); setTranscript(final.transcript.trim()); finalTranscript.current = final.transcript.trim();
          setMetrics(previous => ({ ...previous, transcriptionMs: previous.transcriptionMs + final.durationMs }));
          setProvider(final.provider); setMessage(""); setStatus("ready");
          window.setTimeout(() => document.getElementById("capture")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }), 200);
        } catch (error) {
          if (liveWhisper.current !== liveSession) return;
          setStatus("error"); setMessage(error instanceof Error ? error.message : "Final transcription failed.");
        }
      };
      recording.start(4000);
      listening.current = true; started.current = performance.now(); setStatus("listening");
      const SpeechCtor = (window as SpeechWindow).SpeechRecognition || (window as SpeechWindow).webkitSpeechRecognition;
      if (SpeechCtor && selectedDeviceId === "default") {
        const speech = new SpeechCtor();
        speech.continuous = true; speech.interimResults = true; speech.lang = "en-IN";
        speech.onresult = event => {
          let partial = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const phrase = event.results[i][0].transcript.trim();
            if (event.results[i].isFinal) finalTranscript.current = `${finalTranscript.current} ${phrase}`.trim();
            else partial += `${phrase} `;
          }
          setTranscript(finalTranscript.current);
          setInterim(partial.trim());
        };
        speech.onerror = event => {
          if (event.error === "no-speech" || !listening.current) return;
          browserSpeechFailed.current = true;
          liveMode.current = true;
          liveSession.enable();
          setProvider("Groq Whisper (live fallback)");
          setMessage(`Browser speech failed (${event.error}); switched to live Whisper updates.`);
        };
        speech.onend = () => { if (listening.current && !browserSpeechFailed.current) { try { speech.start(); } catch { browserSpeechFailed.current = true; liveMode.current = true; liveSession.enable(); setProvider("Groq Whisper (live fallback)"); } } };
        recognition.current = speech;
        try { speech.start(); setProvider("Browser Speech Recognition"); }
        catch { recognition.current = null; browserSpeechFailed.current = true; liveMode.current = true; liveSession.enable(); setProvider("Groq Whisper (live fallback)"); }
      } else { liveMode.current = true; liveSession.enable(); setProvider("Groq Whisper (live updates)"); }
    } catch (error) {
      listening.current = false;
      liveWhisper.current?.cancel();
      stream.current?.getTracks().forEach(track => track.stop());
      setStatus("error"); setMessage(error instanceof Error ? error.message : "Microphone access failed.");
    }
  }

  function stopRecording() {
    if (!listening.current) return;
    listening.current = false; setStatus("stopping"); setInterim("");
    recognition.current?.stop();
    if (recorder.current?.state === "recording") recorder.current.stop();
    const recordingMs = Math.round(performance.now() - started.current);
    setElapsed(recordingMs);
    setMetrics(previous => ({ ...previous, recordingMs }));
  }

  async function transcribeAudio() {
    if (!audio.current) { setMessage("Record audio first."); return; }
    setStatus("transcribing"); setMessage("");
    try {
      const data = await requestWhisper(audio.current, "accurate", vocabularyHints);
      setFinalV3(data.transcript.trim()); setTranscript(data.transcript.trim()); finalTranscript.current = data.transcript.trim();
      setMetrics(previous => ({ ...previous, transcriptionMs: data.durationMs }));
      setProvider(data.provider); setStatus("ready");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Transcription failed."); }
  }

  async function extractTasks() {
    if (!transcript.trim()) { setMessage("Record or type a transcript first."); return; }
    setStatus("processing"); setMessage(""); setTasks([]); setPredictedTasks([]); setReviewKey(""); setReviewMessage(""); setSavedCurrentResult(false);
    try {
      const response = await fetch("/api/extract", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: transcript.trim(), currentDate: localDate(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Task extraction failed.");
      const model = typeof data.model === "string" ? data.model : "openai/gpt-oss-20b";
      const predicted = data.tasks as Task[];
      const modelCalibration = calculateCalibration(reviews, model);
      setTasks(predicted.map(task => ({ ...task, confidence: calibratedConfidence(modelCalibration, task) })));
      setPredictedTasks(predicted);
      setExtractionModel(model);
      setReviewKey(JSON.stringify([transcript.trim(), localDate(), model]));
      setMissedTasks(0);
      setMetrics(previous => ({ ...previous, extractionMs: data.durationMs }));
      setStatus("complete");
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "Task extraction failed."); }
  }

  function updateTask(id: string, field: keyof Task, value: unknown) {
    setTasks(current => current.map(task => task.id === id ? { ...task, [field]: value } : task));
  }

  function saveToHistory() {
    if (!tasks.length || savedCurrentResult) return;
    const now = new Date().toISOString();
    const saved = tasks.map((task, index) => ({ ...task, id: `${Date.now()}-${index}`, savedAt: now }));
    const updated = [...saved, ...historyTasks];
    try { localStorage.setItem(historyStorageKey, JSON.stringify(updated)); }
    catch { setMessage("Could not save task history in this browser."); return; }
    setHistoryTasks(updated);
    setSavedCurrentResult(true);
    setMessage(`${saved.length} task${saved.length === 1 ? "" : "s"} saved to your history.`);
  }

  function updateHistoryStatus(id: string, status: Task["status"]) {
    const updated = historyTasks.map(task => task.id === id ? { ...task, status } : task);
    try { localStorage.setItem(historyStorageKey, JSON.stringify(updated)); }
    catch { setMessage("Could not update task history in this browser."); return; }
    setHistoryTasks(updated);
  }

  function removeHistoryTask(id: string) {
    if (!window.confirm("Remove this task from history?")) return;
    const updated = historyTasks.filter(task => task.id !== id);
    try { localStorage.setItem(historyStorageKey, JSON.stringify(updated)); }
    catch { setMessage("Could not update task history in this browser."); return; }
    setHistoryTasks(updated);
  }

  function saveReview() {
    if (!reviewKey || predictedTasks.length !== tasks.length) return;
    const review: Review = {
      key: reviewKey,
      reviewedAt: new Date().toISOString(),
      version: CALIBRATION_VERSION,
      model: extractionModel,
      transcript: JSON.parse(reviewKey)[0],
      predicted: predictedTasks.map(reviewedFields),
      corrected: tasks.map(reviewedFields),
      missedTasks,
    };
    const updated = [...reviews.filter(item => item.key !== reviewKey), review];
    try { localStorage.setItem(reviewStorageKey, JSON.stringify(updated)); }
    catch { setReviewMessage("Could not save the review in this browser."); return; }
    setReviews(updated);
    setReviewMessage("Review saved on this device. Re-reviewing this transcript replaces its earlier label.");
  }

  function exportReviews() {
    const blob = new Blob([JSON.stringify({ version: CALIBRATION_VERSION, reviews }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = "voxtask-calibration-reviews.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;
  const totalMs = metrics.transcriptionMs + metrics.extractionMs;
  const calibration = calculateCalibration(reviews, extractionModel);
  function finishIntro() {
    introDoneRef.current = true;
    setIntroDone(true);
    const progress = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.9)));
    document.documentElement.style.setProperty("--dock-progress", String(progress));
    const visible = progress > 0.85;
    dockVisibilityRef.current = visible;
    setDockVisible(visible);
  }
  return <main className="shell">
    <RecordOrb recording={status === "listening"} busy={status === "stopping" || status === "transcribing" || status === "processing"} ready={introDone} onReady={finishIntro} onPress={status === "listening" ? stopRecording : startRecording} />
    {introDone && (status === "listening" || status === "stopping" || status === "transcribing") && <div className="orb-status" role="status">{status === "listening" ? "RECORDING · TAP CIRCLE TO STOP" : status === "stopping" ? "FINISHING RECORDING" : "TRANSCRIBING AUDIO"}</div>}
    <footer className={`record-dock ${dockVisible ? "is-visible" : ""}`} aria-hidden={!dockVisible} inert={!dockVisible}>
      <a className="dock-brand" href="#top" aria-label="VOXTASK home">voxtask<span>.</span><small>VOICE → ACTION</small></a>
      <span className="dock-orb-space" aria-hidden="true" />
      <nav aria-label="Main navigation"><a href="#tasks">TASKS</a><a href="#capture">CAPTURE</a><a href="#settings">SETTINGS</a></nav>
    </footer>
    <div className={`site-content ${introDone ? "is-ready" : ""}`}>
    <section className="hero" id="top" aria-label="Record a thought" />
    <section className="history-section" id="tasks"><div className="history-heading"><div><p className="eyebrow">YOUR WORKSPACE</p><h1>Task history<span>.</span></h1></div><span className="count">{historyTasks.length} saved</span></div>
      {historyTasks.length ? <div className="history-grid">{historyTasks.map(task => <article className={`history-card priority-border-${task.priority}`} key={task.id}><div className="history-card-top"><span className={`priority priority-${task.priority}`}>{task.priority}</span><span>{task.dueDate ?? task.dueDateText ?? "No due date"}{task.dueTimeText ? ` · ${task.dueTimeText}` : task.dueTime ? ` · ${task.dueTime}` : ""}</span></div><h2>{task.title}</h2><p>{task.description || task.sourceText}</p><div className="history-card-foot"><span>Added {new Date(task.savedAt).toLocaleDateString()}</span><div className="history-card-controls"><label>Status <select value={task.status} onChange={event => updateHistoryStatus(task.id, event.target.value as Task["status"])}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label><button onClick={() => removeHistoryTask(task.id)} aria-label={`Remove ${task.title} from history`}>Remove</button></div></div></article>)}</div> : <p className="history-empty">Your captured tasks will land here. Tap the circle to begin.</p>}
    </section>
    <section className="workbench" id="capture"><div className="workbench-heading"><p className="eyebrow">CAPTURE STUDIO</p><h2>From thought to task<span>.</span></h2><p>Speak naturally, review the transcript, then save what matters.</p></div>

    <details className="diagnostics" id="settings"><summary>Input settings & diagnostics</summary>
    <section className="panel"><div className="section-head"><h2>Input settings</h2><span className={`state state-${status}`}>{status}</span></div>
      <div className="device-row"><label htmlFor="input-device">Input device<select id="input-device" value={selectedDeviceId} disabled={status === "listening" || status === "processing" || status === "transcribing"} onChange={event => { setSelectedDeviceId(event.target.value); setInputDevice("Not recording yet"); }}><option value="default">System default microphone</option>{devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></label><button onClick={refreshDevices} disabled={status === "listening" || status === "processing" || status === "transcribing"}>Refresh devices</button></div>
      <label className="hints" htmlFor="vocabulary-hints">Vocabulary hints for names and terms<input id="vocabulary-hints" value={vocabularyHints} maxLength={500} disabled={status === "listening" || status === "transcribing"} onChange={event => setVocabularyHints(event.target.value)} placeholder="Names, acronyms, project terms" /></label>
      <p className="device-note">Browser speech uses the default microphone. Other devices, or browser speech failures, update through Whisper about every 4 seconds.</p>
      <div className="actions"><button onClick={transcribeAudio} disabled={!hasAudio || status === "listening" || status === "processing" || status === "transcribing"}>Retry Whisper V3</button></div>
      {recordingUrl && <div className="recording-review"><span>Check captured audio quality</span><audio controls preload="metadata" src={recordingUrl} /><a href={recordingUrl} download="voxtask-recording.webm">Download clip</a></div>}
      <div className="meta"><span>Microphone: {status === "listening" ? "Listening" : "Ready"}</span><span>Recorded device: <strong>{inputDevice}</strong></span><span>Duration: {(elapsed / 1000).toFixed(1)} s</span><span>Provider: {provider}</span></div>
    </section>
    </details>

    <section className="panel"><div className="section-head"><h2>02 / Live transcript</h2><div className="mini-actions"><button onClick={() => { setTranscript(""); finalTranscript.current = ""; setTasks([]); setReviewKey(""); }}>Clear</button><button onClick={() => navigator.clipboard.writeText(transcript)}>Copy</button><button onClick={() => { setTranscript(sample); finalTranscript.current = sample; setTasks([]); setReviewKey(""); }}>Load sample</button></div></div>
      <textarea aria-label="Transcript" placeholder="Speak, type, or load the sample transcript…" value={transcript} onChange={event => { setTranscript(event.target.value); finalTranscript.current = event.target.value; setReviewKey(""); }} />
      {interim && <p className="interim">Hearing: {interim}</p>}
      {liveDraft && finalV3 && liveDraft !== finalV3 && <details className="draft"><summary>Compare transcription versions</summary><p><strong>Live Turbo:</strong> {liveDraft}</p><button onClick={() => { setTranscript(liveDraft); finalTranscript.current = liveDraft; setReviewKey(""); setProvider("Groq Whisper Large V3 Turbo (selected)"); }}>Use live version</button><p><strong>Final V3:</strong> {finalV3}</p><button onClick={() => { setTranscript(finalV3); finalTranscript.current = finalV3; setReviewKey(""); setProvider("Groq Whisper Large V3 (selected)"); }}>Use final version</button></details>}
      <div className="meta"><span>Words: {wordCount}</span><span>Language: en-IN</span><span>Local date: {localDate()}</span></div>
    </section>

    <button className="extract" onClick={extractTasks} disabled={!transcript.trim() || status === "listening" || status === "processing" || status === "transcribing"}>{status === "processing" ? "Understanding your tasks…" : "Extract tasks →"}</button>
    {message && <div role="alert" className="alert">{message}</div>}

    <section className="panel"><div className="section-head"><h2>Extracted tasks</h2><span className="count">{tasks.length} detected</span></div>
      {tasks.length === 0 ? <p className="empty">No tasks yet. Extract from a transcript to inspect the result.</p> : <div className="task-list">{tasks.map(task => <article className="task" key={task.id}>
        <div className="task-heading"><input aria-label="Task title" value={task.title} onChange={event => updateTask(task.id, "title", event.target.value)} /><span className={task.needsConfirmation ? "review" : "verified"}>{task.needsConfirmation ? "Needs confirmation" : "Ready to review"}</span></div>
        <label>Description<textarea value={task.description ?? ""} onChange={event => updateTask(task.id, "description", event.target.value || null)} /></label>
        <div className="fields"><label>Priority<select value={task.priority} onChange={event => updateTask(task.id, "priority", event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Due date<input type="date" value={task.dueDate ?? ""} onChange={event => updateTask(task.id, "dueDate", event.target.value || null)} /></label><label>Due time<input type="time" value={task.dueTime ?? ""} onChange={event => updateTask(task.id, "dueTime", event.target.value || null)} /></label><label>Status<select value={task.status} onChange={event => updateTask(task.id, "status", event.target.value)}><option value="todo">Todo</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label></div>
        <div className="fields audit-fields"><label>Spoken date<input value={task.dueDateText ?? ""} onChange={event => updateTask(task.id, "dueDateText", event.target.value || null)} placeholder="e.g. Friday" /></label><label>Spoken time / constraint<input value={task.dueTimeText ?? ""} onChange={event => updateTask(task.id, "dueTimeText", event.target.value || null)} placeholder="e.g. before class" /></label><label>Dependencies<input value={task.dependencies.join(", ")} onChange={event => updateTask(task.id, "dependencies", event.target.value.split(",").map(part => part.trim()).filter(Boolean))} /></label><div className="uncalibrated">{task.confidence ? `Observed accuracy: title ${formatConfidence(task.confidence.task)}, date/time ${formatConfidence(task.confidence.date)}, priority ${formatConfidence(task.confidence.priority)}` : "Confidence: gathering reviews"}</div></div>
        <label>Source fragment<textarea value={task.sourceText} onChange={event => updateTask(task.id, "sourceText", event.target.value)} /></label>
        <label className="confirmation"><input type="checkbox" checked={task.needsConfirmation} onChange={event => updateTask(task.id, "needsConfirmation", event.target.checked)} /> Needs confirmation</label>
      </article>)}</div>}
      {tasks.length > 0 && <button className="save-history" onClick={saveToHistory} disabled={savedCurrentResult}>{savedCurrentResult ? "Saved to task history" : `Save ${tasks.length} task${tasks.length === 1 ? "" : "s"} to history →`}</button>}
    </section>

    <details className="diagnostics"><summary>Calibration reviews</summary>
    <section className="panel"><div className="section-head"><h2>Calibration reviews</h2><span className="count">{calibration.task.total} reviewed tasks</span></div>
      <p className="device-note">Correct the task cards above, then save your review. Even when every field is right, save a review so accuracy counts it. Reviews stay in this browser until you export them.</p>
      <div className="calibration-actions"><label>Tasks the extractor missed <input type="number" min="0" max="30" value={missedTasks} onChange={event => setMissedTasks(Math.max(0, Math.min(30, Number(event.target.value) || 0)))} /></label><button onClick={saveReview} disabled={!reviewKey}>Save reviewed result</button><button onClick={exportReviews} disabled={!reviews.length}>Export reviews</button></div>
      {reviewMessage && <p role="status" className="device-note">{reviewMessage}</p>}
      <div className="calibration-stats">{(["task", "date", "priority", "status"] as const).map(field => <div key={field}><strong>{field === "task" ? "Title" : field === "date" ? "Date & time" : field === "status" ? "Status" : "Priority"}</strong><span>{calibration[field].total ? `${calibration[field].correct}/${calibration[field].total} correct · ${Math.round(calibration[field].rate! * 100)}% observed` : "No reviews yet"}</span>{calibration[field].lower !== null && <small>95% interval: {Math.round(calibration[field].lower! * 100)}–{Math.round(calibration[field].upper! * 100)}%</small>}</div>)}</div>
      <p className="device-note">A title score needs {MIN_REVIEWED_TASKS} reviewed tasks for this model. Date/time and priority scores also need {MIN_REVIEWED_TASKS} reviews in the same output group. Status accuracy tracks corrected To do, In progress, and Done labels in new reviews. These are observed group accuracy, not certainty about an individual task. {calibration.missedTasks} missed tasks reported separately.</p>
    </section>
    </details>
    <details className="panel json"><summary>05 / Raw task JSON</summary><div className="mini-actions"><button onClick={() => navigator.clipboard.writeText(JSON.stringify({ tasks }, null, 2))}>Copy JSON</button><button onClick={() => setTasks([])}>Clear result</button></div><pre>{JSON.stringify({ tasks }, null, 2)}</pre></details>
    <footer className="metrics"><span>Recording <strong>{formatMs(metrics.recordingMs)}</strong></span><span>Transcription <strong>{formatMs(metrics.transcriptionMs)}</strong></span><span>AI extraction <strong>{formatMs(metrics.extractionMs)}</strong></span><span>API processing <strong>{formatMs(totalMs)}</strong></span><span>Tasks <strong>{tasks.length}</strong></span></footer>
    </section>
    </div>
  </main>;
}
