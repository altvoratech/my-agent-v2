import type { PanelEvent } from "./ToolPanel";

export type PanelRow =
  | { kind: "single"; event: PanelEvent }
  | { kind: "run"; toolName: string; items: PanelEvent[] };

// Colapsa sequências maximais de eventos adjacentes com kind "tool" e mesmo
// toolName (>=2) em um único PanelRow do tipo "run". Guard/prefetch nunca
// colapsam e quebram qualquer run.
export function groupConsecutive(events: PanelEvent[]): PanelRow[] {
  const rows: PanelRow[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.kind === "tool") {
      const items: PanelEvent[] = [ev];
      let j = i + 1;
      while (j < events.length) {
        const next = events[j];
        if (next.kind === "tool" && next.toolName === ev.toolName) {
          items.push(next);
          j++;
        } else {
          break;
        }
      }
      if (items.length >= 2) {
        rows.push({ kind: "run", toolName: ev.toolName, items });
      } else {
        rows.push({ kind: "single", event: ev });
      }
      i = j;
    } else {
      rows.push({ kind: "single", event: ev });
      i++;
    }
  }
  return rows;
}
