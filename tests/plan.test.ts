import { describe, expect, it } from "vitest";
import type { Finding } from "../analyze";
import { cellText, group, readMode } from "../plan";

const f = (id: string, level: Finding["level"], recommended: boolean, repairable = true): Finding => ({
  id, level, section: null, title: id, detail: "", repair: repairable ? { kind: "reorder" } : null, recommended,
});

describe("what happens to the findings", () => {
  it("repairs the recommended ones, asks about the other errors and warnings, and notes the rest", () => {
    const g = group([f("length", "warn", true), f("era", "info", true), f("side", "warn", false), f("dim", "error", false, false), f("order", "info", false), f("inherent", "info", false, false)]);
    expect(g.safe.map((x) => x.id)).toEqual(["length", "era"]);
    expect(g.review.map((x) => x.id)).toEqual(["side", "dim"]);
    expect(g.notes.map((x) => x.id)).toEqual(["order", "inherent"]);
  });

  it("reads the stored choice, and what the old tick meant", () => {
    expect(readMode("ask", true)).toBe("ask");
    expect(readMode("off", true)).toBe("off");
    expect(readMode(null, true)).toBe("auto");
    expect(readMode(undefined, false)).toBe("off");
    expect(readMode("nonsense", undefined)).toBe("auto");
  });
});

describe("the status bar cell", () => {
  const none = { safe: [], review: [], notes: [] };
  it("is not there for a clean map, nor for one with only notes", () => {
    expect(cellText(none, 0)).toBeNull();
    expect(cellText({ ...none, notes: [f("order", "info", false)] }, 0)).toBeNull();
  });

  it("says what was repaired and what is left", () => {
    expect(cellText(none, 5)).toEqual({ text: "Repaired 5", warn: false });
    expect(cellText({ ...none, review: [f("a", "warn", false), f("b", "error", false)] }, 5)).toEqual({ text: "Repaired 5 · 2 to review", warn: true });
    expect(cellText({ ...none, safe: [f("a", "warn", true)], review: [f("b", "warn", false)] }, 0)).toEqual({ text: "Repair: 1 to fix · 1 to review", warn: true });
  });
});
