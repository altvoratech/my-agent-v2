import { describe, it, expect } from "vitest";
import { groupConsecutive, type PanelRow } from "./toolPanelGrouping";
import type { PanelEvent } from "./ToolPanel";

let seq = 0;
function tool(toolName: string): PanelEvent {
  return { id: `t${seq++}`, kind: "tool", toolName, timestamp: "2026-07-09T10:00:00Z" };
}
function guard(): PanelEvent {
  return { id: `g${seq++}`, kind: "guard", tool: "Bash", reason: "nope", timestamp: "2026-07-09T10:00:00Z" };
}
function prefetch(): PanelEvent {
  return { id: `p${seq++}`, kind: "prefetch", hits: 1, sources: ["x"], timestamp: "2026-07-09T10:00:00Z" };
}

// Concatena os eventos de todos os PanelRow, na ordem, para checar preservação.
function flatten(rows: PanelRow[]): PanelEvent[] {
  return rows.flatMap((r) => (r.kind === "single" ? [r.event] : r.items));
}

describe("groupConsecutive", () => {
  it("colapsa runs consecutivos do mesmo toolName preservando ordem dos items", () => {
    const a = tool("Read");
    const b = tool("Read");
    const c = tool("Read");
    const rows = groupConsecutive([a, b, c]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("run");
    if (rows[0].kind === "run") {
      expect(rows[0].toolName).toBe("Read");
      expect(rows[0].items).toEqual([a, b, c]);
    }
  });

  it("tools de nomes diferentes NÃO colapsam (dois singles)", () => {
    const a = tool("Read");
    const b = tool("Write");
    const rows = groupConsecutive([a, b]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ kind: "single", event: a });
    expect(rows[1]).toEqual({ kind: "single", event: b });
  });

  it("um guard entre dois eventos tool iguais quebra em dois runs/singles", () => {
    const a = tool("Read");
    const b = tool("Read");
    const g = guard();
    const c = tool("Read");
    const d = tool("Read");
    const rows = groupConsecutive([a, b, g, c, d]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "run", toolName: "Read", items: [a, b] });
    expect(rows[1]).toEqual({ kind: "single", event: g });
    expect(rows[2]).toMatchObject({ kind: "run", toolName: "Read", items: [c, d] });
  });

  it("um prefetch entre dois eventos tool iguais quebra o run", () => {
    const a = tool("Read");
    const p = prefetch();
    const b = tool("Read");
    const rows = groupConsecutive([a, p, b]);
    expect(rows).toEqual([
      { kind: "single", event: a },
      { kind: "single", event: p },
      { kind: "single", event: b },
    ]);
  });

  it("guard e prefetch sempre viram single, nunca run", () => {
    const g1 = guard();
    const g2 = guard();
    const p1 = prefetch();
    const p2 = prefetch();
    const rows = groupConsecutive([g1, g2, p1, p2]);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.kind === "single")).toBe(true);
  });

  it("run de tamanho 1 vira single", () => {
    const a = tool("Read");
    const rows = groupConsecutive([a]);
    expect(rows).toEqual([{ kind: "single", event: a }]);
  });

  it("array vazio → []", () => {
    expect(groupConsecutive([])).toEqual([]);
  });

  it("ordem geral preservada (concatenação = input)", () => {
    const input = [tool("Read"), tool("Read"), guard(), tool("Write"), prefetch(), tool("Read")];
    const rows = groupConsecutive(input);
    expect(flatten(rows)).toEqual(input);
  });
});
