import { describe, expect, it } from "vitest";
import { normalizeTasks } from "./tasks";

const base = {
  title: "Call Adarsh", description: null, priority: "medium", dueDate: null, dueDateText: null, dueTime: null, dueTimeText: null,
  dependencies: [], sourceText: "call Adarsh", status: "todo", needsConfirmation: false,
};

describe("normalizeTasks", () => {
  it("keeps tasks tied to their exact transcript source", () => {
    const tasks = normalizeTasks({ tasks: [base, { ...base, title: "Invented task", sourceText: "buy a car" }] }, "Tomorrow call Adarsh.", "2026-10-07");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "task_1", status: "todo", sourceText: "call Adarsh" });
  });

  it("does not keep invalid dates and marks them for confirmation", () => {
    const tasks = normalizeTasks({ tasks: [{ ...base, dueDate: "2026-02-30" }] }, "Please call Adarsh.", "2026-10-07");
    expect(tasks[0].dueDate).toBeNull();
    expect(tasks[0].needsConfirmation).toBe(true);
  });

  it("accepts an empty extraction", () => {
    expect(normalizeTasks({ tasks: [] }, "I am tired today.", "2026-10-07")).toEqual([]);
  });

  it("keeps explicit in-progress and completed statuses", () => {
    const transcript = "I started the presentation yesterday. I already called Adarsh.";
    const tasks = normalizeTasks({ tasks: [
      { ...base, title: "Finish the presentation", sourceText: "started the presentation", status: "in_progress" },
      { ...base, title: "Call Adarsh", sourceText: "already called Adarsh", status: "done" },
    ] }, transcript, "2026-10-07");
    expect(tasks.map(task => task.status)).toEqual(["in_progress", "done"]);
  });

  it("preserves spoken time constraints and corrects Friday from the local date", () => {
    const transcript = "Tomorrow before class finish the presentation, then call Adarsh about the hackathon. Submit the final PPT by Friday evening, and maybe buy an SSD sometime this weekend.";
    const tasks = normalizeTasks({ tasks: [
      { ...base, title: "Finish presentation", sourceText: "finish the presentation", dueDate: "2026-10-08", dueDateText: "Tomorrow", dueTimeText: "before class" },
      { ...base, title: "Call Adarsh", sourceText: "then call Adarsh about the hackathon", dueDate: null, dueDateText: null, dueTimeText: "before class", needsConfirmation: true },
      { ...base, title: "Submit final PPT", sourceText: "Submit the final PPT by Friday evening", dueDate: "2026-10-07", dueDateText: "Friday", dueTimeText: "evening" },
      { ...base, title: "Buy SSD", sourceText: "maybe buy an SSD sometime this weekend", priority: "low", dueDate: "2026-10-10", dueDateText: "this weekend" },
    ] }, transcript, "2026-10-07");
    expect(tasks[0]).toMatchObject({ dueDate: "2026-10-08", dueTime: null, dueTimeText: "before class", needsConfirmation: true, confidence: null });
    expect(tasks[1]).toMatchObject({ dueDate: "2026-10-08", dueDateText: "Tomorrow", dueTimeText: null, needsConfirmation: false });
    expect(tasks[2]).toMatchObject({ dueDate: "2026-10-09", dueTime: null, dueTimeText: "evening", needsConfirmation: true });
    expect(tasks[3]).toMatchObject({ dueDate: null, dueDateText: "this weekend", priority: "low", needsConfirmation: true });
  });
});
