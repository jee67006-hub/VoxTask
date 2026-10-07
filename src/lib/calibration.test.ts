import { describe, expect, it } from "vitest";
import { calculateCalibration, calibratedConfidence, parseReviews, type Review } from "./calibration";
import type { Task } from "./tasks";

const fields = { title: "Call Adarsh", dueDate: "2026-10-08", dueDateText: "tomorrow", dueTime: null, dueTimeText: null, priority: "medium" as const };
const review: Review = { key: "one", reviewedAt: "2026-10-07T00:00:00.000Z", version: 1, model: "model-a", transcript: "Tomorrow call Adarsh", predicted: [fields], corrected: [{ ...fields, title: "Call Adarsh", dueDate: "2026-10-09", priority: "high" }], missedTasks: 1 };
const task: Task = { ...fields, id: "task_1", description: null, status: "todo", dependencies: [], sourceText: "call Adarsh", confidence: null, needsConfirmation: false };

describe("calibration", () => {
  it("measures reviewed fields and keeps missed tasks separate", () => {
    const result = calculateCalibration([review], "model-a");
    expect(result.task).toMatchObject({ correct: 1, total: 1, rate: 1 });
    expect(result.date).toMatchObject({ correct: 0, total: 1, rate: 0 });
    expect(result.priority).toMatchObject({ correct: 0, total: 1, rate: 0 });
    expect(result.missedTasks).toBe(1);
    expect(result.task.lower).toBeLessThan(1);
    expect(calibratedConfidence(result, task)).toBeNull();
  });

  it("requires 30 reviews for the same model before showing empirical scores", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...review, key: String(index) }));
    expect(calibratedConfidence(calculateCalibration(many, "model-a"), task)).toEqual({ task: 1, date: 0, priority: 0 });
    expect(calibratedConfidence(calculateCalibration(many, "model-a"), { ...task, priority: "low" })).toEqual({ task: 1, date: 0, priority: null });
    expect(calibratedConfidence(calculateCalibration(many, "model-b"), task)).toBeNull();
  });

  it("drops malformed stored reviews", () => {
    expect(parseReviews([review, { ...review, missedTasks: -1 }, { ...review, version: 2 }])).toHaveLength(1);
  });
});
