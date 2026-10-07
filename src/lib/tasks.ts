import { z } from "zod";

export const taskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().nullable(),
  priority: z.enum(["low", "medium", "high"]),
  dueDate: z.iso.date().nullable(),
  dueDateText: z.string().nullable(),
  dueTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  dueTimeText: z.string().nullable(),
  status: z.enum(["todo", "in_progress", "done"]),
  dependencies: z.array(z.string()),
  sourceText: z.string().min(1),
  confidence: z.object({ task: z.number().min(0).max(1).nullable(), date: z.number().min(0).max(1).nullable(), priority: z.number().min(0).max(1).nullable() }).nullable(),
  needsConfirmation: z.boolean(),
});

export type Task = z.infer<typeof taskSchema>;

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };

export const extractionJsonSchema = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: nullableString,
          priority: { type: "string", enum: ["low", "medium", "high"] },
          status: { type: "string", enum: ["todo", "in_progress", "done"] },
          dueDate: nullableString,
          dueDateText: nullableString,
          dueTime: nullableString,
          dueTimeText: nullableString,
          dependencies: { type: "array", items: { type: "string" } },
          sourceText: { type: "string" },
        },
        required: ["title", "description", "priority", "status", "dueDate", "dueDateText", "dueTime", "dueTimeText", "dependencies", "sourceText"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasks"], additionalProperties: false,
} as const;

const modelTaskSchema = taskSchema.omit({ id: true, confidence: true, needsConfirmation: true }).extend({ dueDate: z.string().nullable(), dueTime: z.string().nullable() });
const modelResponseSchema = z.object({ tasks: z.array(modelTaskSchema).max(30) });

function exactPhrase(transcript: string, phrase: string | null): string | null {
  if (!phrase?.trim()) return null;
  const trimmed = phrase.trim();
  const start = transcript.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase());
  return start < 0 ? null : transcript.slice(start, start + trimmed.length);
}

function scopedDatePhrase(transcript: string, taskStart: number): string | null {
  const prefix = transcript.slice(0, taskStart);
  const boundary = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("?"), prefix.lastIndexOf("!"));
  const sentencePrefix = prefix.slice(boundary + 1);
  const phrases = [...sentencePrefix.matchAll(/\b(?:tomorrow|today|tonight|this weekend|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi)];
  return phrases.at(-1)?.[0] ?? null;
}

function scopedTimePhrase(transcript: string, phrase: string | null, taskStart: number, taskEnd: number, otherTaskStarts: number[]): string | null {
  const exact = exactPhrase(transcript, phrase);
  if (!exact) return null;
  const phraseStart = transcript.toLocaleLowerCase().indexOf(exact.toLocaleLowerCase());
  const before = transcript.slice(0, taskStart);
  const sentenceStart = Math.max(before.lastIndexOf("."), before.lastIndexOf("?"), before.lastIndexOf("!")) + 1;
  const laterBoundaries = [".", "?", "!"].map(mark => transcript.indexOf(mark, taskStart)).filter(index => index >= 0);
  const sentenceEnd = laterBoundaries.length ? Math.min(...laterBoundaries) : transcript.length;
  if (phraseStart < sentenceStart || phraseStart >= sentenceEnd) return null;
  if (phraseStart < taskStart && otherTaskStarts.some(start => start > phraseStart && start < taskStart)) return null;
  if (phraseStart >= taskEnd && otherTaskStarts.some(start => start > taskEnd && start < phraseStart)) return null;
  return exact;
}

function resolvedDate(phrase: string | null, currentDate: string): string | null {
  if (!phrase) return null;
  const words = phrase.toLocaleLowerCase();
  if (/\bweekend\b/.test(words)) return null; // A weekend names a range, not one date.
  const base = new Date(`${currentDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  let days: number | null = null;
  if (/\btomorrow\b/.test(words)) days = 1;
  else if (/\btoday\b|\btonight\b/.test(words)) days = 0;
  else {
    const weekday = words.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
    if (weekday) {
      const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday[1]);
      days = (target - base.getUTCDay() + 7) % 7;
      if (/\bnext\b/.test(words)) days += 7;
    }
  }
  if (days === null) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

export function normalizeTasks(raw: unknown, transcript: string, currentDate: string): Task[] {
  const parsed = modelResponseSchema.parse(raw);
  const accepted: Task[] = [];
  const taskStarts = parsed.tasks.map(item => transcript.toLocaleLowerCase().indexOf(item.sourceText.trim().toLocaleLowerCase())).filter(start => start >= 0);
  for (const item of parsed.tasks) {
    const start = transcript.toLocaleLowerCase().indexOf(item.sourceText.trim().toLocaleLowerCase());
    if (start < 0) continue; // A task without a traceable source is not trustworthy.
    const dateText = exactPhrase(transcript, item.dueDateText) ?? (item.dueDateText === null ? scopedDatePhrase(transcript, start) : null);
    const timeText = scopedTimePhrase(transcript, item.dueTimeText, start, start + item.sourceText.trim().length, taskStarts);
    const dueDate = resolvedDate(dateText, currentDate);
    const clockIsExplicit = !!timeText && /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b/i.test(timeText);
    const dueTime = clockIsExplicit && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.dueTime ?? "") ? item.dueTime : null;
    const sourceText = transcript.slice(start, start + item.sourceText.trim().length);
    accepted.push(taskSchema.parse({
      ...item,
      id: `task_${accepted.length + 1}`,
      status: item.status,
      sourceText,
      dueDate,
      dueDateText: dateText,
      dueTime,
      dueTimeText: timeText,
      confidence: null,
      needsConfirmation: /\b(?:maybe|perhaps|possibly|sometime)\b/i.test(sourceText) || (dateText !== null && dueDate === null) || (item.dueDate !== null && dateText === null) || (timeText !== null && !clockIsExplicit) || (item.dueTime !== null && dueTime === null),
    }));
  }
  return accepted;
}
