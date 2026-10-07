import { z } from "zod";
import type { Task } from "./tasks";

export const CALIBRATION_VERSION = 1;
export const MIN_REVIEWED_TASKS = 30;

const reviewedFieldsSchema = z.object({
  title: z.string(),
  dueDate: z.string().nullable(),
  dueDateText: z.string().nullable(),
  dueTime: z.string().nullable(),
  dueTimeText: z.string().nullable(),
  priority: z.enum(["low", "medium", "high"]),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
});
export type ReviewedFields = z.infer<typeof reviewedFieldsSchema>;

export const reviewSchema = z.object({
  key: z.string(),
  reviewedAt: z.string(),
  version: z.literal(CALIBRATION_VERSION),
  model: z.string(),
  transcript: z.string(),
  predicted: z.array(reviewedFieldsSchema),
  corrected: z.array(reviewedFieldsSchema),
  missedTasks: z.number().int().min(0),
});
export type Review = z.infer<typeof reviewSchema>;
export type ConfidenceField = "task" | "date" | "priority" | "status";
export type FieldAccuracy = { correct: number; total: number; rate: number | null; lower: number | null; upper: number | null };
export type Calibration = Record<ConfidenceField, FieldAccuracy> & {
  byDatePresence: Record<"specified" | "none", FieldAccuracy>;
  byPriority: Record<"low" | "medium" | "high", FieldAccuracy>;
  missedTasks: number;
  reviews: number;
};

export function reviewedFields(task: Task): ReviewedFields {
  return {
    title: task.title,
    dueDate: task.dueDate,
    dueDateText: task.dueDateText,
    dueTime: task.dueTime,
    dueTimeText: task.dueTimeText,
    priority: task.priority,
    status: task.status,
  };
}

function sameText(a: string | null, b: string | null): boolean {
  return (a ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase() === (b ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function wilson(correct: number, total: number): FieldAccuracy {
  if (!total) return { correct, total, rate: null, lower: null, upper: null };
  const rate = correct / total;
  const z = 1.96;
  const denominator = 1 + z * z / total;
  const center = (rate + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total)) / denominator;
  return { correct, total, rate, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function calculateCalibration(reviews: Review[], model: string): Calibration {
  const counts = { task: 0, date: 0, priority: 0, status: 0 };
  let statusTotal = 0;
  const dateCounts = { specified: { correct: 0, total: 0 }, none: { correct: 0, total: 0 } };
  const priorityCounts = { low: { correct: 0, total: 0 }, medium: { correct: 0, total: 0 }, high: { correct: 0, total: 0 } };
  let total = 0;
  let missedTasks = 0;
  let reviewCount = 0;
  for (const review of reviews) {
    if (review.version !== CALIBRATION_VERSION || review.model !== model) continue;
    reviewCount++;
    missedTasks += review.missedTasks;
    const length = Math.min(review.predicted.length, review.corrected.length);
    for (let i = 0; i < length; i++) {
      const predicted = review.predicted[i];
      const corrected = review.corrected[i];
      total++;
      if (sameText(predicted.title, corrected.title)) counts.task++;
      const dateGroup = predicted.dueDate || predicted.dueDateText || predicted.dueTime || predicted.dueTimeText ? "specified" : "none";
      dateCounts[dateGroup].total++;
      if (predicted.dueDate === corrected.dueDate && predicted.dueTime === corrected.dueTime && sameText(predicted.dueDateText, corrected.dueDateText) && sameText(predicted.dueTimeText, corrected.dueTimeText)) { counts.date++; dateCounts[dateGroup].correct++; }
      priorityCounts[predicted.priority].total++;
      if (predicted.priority === corrected.priority) { counts.priority++; priorityCounts[predicted.priority].correct++; }
      if (predicted.status && corrected.status) {
        statusTotal++;
        if (predicted.status === corrected.status) counts.status++;
      }
    }
  }
  return {
    task: wilson(counts.task, total), date: wilson(counts.date, total), priority: wilson(counts.priority, total), status: wilson(counts.status, statusTotal),
    byDatePresence: { specified: wilson(dateCounts.specified.correct, dateCounts.specified.total), none: wilson(dateCounts.none.correct, dateCounts.none.total) },
    byPriority: { low: wilson(priorityCounts.low.correct, priorityCounts.low.total), medium: wilson(priorityCounts.medium.correct, priorityCounts.medium.total), high: wilson(priorityCounts.high.correct, priorityCounts.high.total) },
    missedTasks, reviews: reviewCount,
  };
}

export function calibratedConfidence(calibration: Calibration, task: Task): Task["confidence"] {
  const dateGroup = task.dueDate || task.dueDateText || task.dueTime || task.dueTimeText ? "specified" : "none";
  const date = calibration.byDatePresence[dateGroup];
  const priority = calibration.byPriority[task.priority];
  const result = {
    task: calibration.task.total >= MIN_REVIEWED_TASKS ? calibration.task.rate : null,
    date: date.total >= MIN_REVIEWED_TASKS ? date.rate : null,
    priority: priority.total >= MIN_REVIEWED_TASKS ? priority.rate : null,
  };
  return result.task === null && result.date === null && result.priority === null ? null : result;
}

export function parseReviews(raw: unknown): Review[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const parsed = reviewSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
