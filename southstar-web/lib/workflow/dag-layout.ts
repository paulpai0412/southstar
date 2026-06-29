import type { WorkflowDag, WorkflowDagNode } from "./types";

const CARD_WIDTH = 154;
const CARD_HEIGHT = 94;
const COLUMN_GAP = 52;
const ROW_GAP = 18;

export type WorkflowDagLayoutNode = {
  node: WorkflowDagNode;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowDagLayout = {
  width: number;
  height: number;
  columns: Array<{ level: number; nodes: WorkflowDagLayoutNode[] }>;
  arrows: Array<{ from: string; to: string; path: string }>;
};

export function layoutWorkflowDag(dag: WorkflowDag): WorkflowDagLayout {
  const levels = Array.from(new Set(dag.nodes.map((node) => node.level))).sort((a, b) => a - b);
  const positioned = new Map<string, WorkflowDagLayoutNode>();
  const columns = levels.map((level, columnIndex) => {
    const nodes = dag.nodes
      .filter((node) => node.level === level)
      .map((node, rowIndex) => {
        const item: WorkflowDagLayoutNode = {
          node,
          x: columnIndex * (CARD_WIDTH + COLUMN_GAP),
          y: rowIndex * (CARD_HEIGHT + ROW_GAP),
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
        };
        positioned.set(node.id, item);
        return item;
      });
    return { level, nodes };
  });

  const maxRows = Math.max(1, ...columns.map((column) => column.nodes.length));
  const width = Math.max(CARD_WIDTH, columns.length * CARD_WIDTH + Math.max(0, columns.length - 1) * COLUMN_GAP);
  const height = Math.max(CARD_HEIGHT, maxRows * CARD_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP);
  const arrows = dag.edges.flatMap((edge) => {
    const from = positioned.get(edge.from);
    const to = positioned.get(edge.to);
    if (!from || !to) {
      return [];
    }
    const startX = from.x + from.width;
    const startY = from.y + from.height / 2;
    const endX = to.x;
    const endY = to.y + to.height / 2;
    const midX = startX + Math.max(22, (endX - startX) / 2);
    return [{ from: edge.from, to: edge.to, path: `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}` }];
  });

  return { width, height, columns, arrows };
}
