"use client";

import { useMemo, useState } from "react";

export type SouthstarBranchNode = {
  id: string;
  label: string;
  role?: "user" | "assistant" | "system";
  children?: SouthstarBranchNode[];
};

export function SouthstarBranchNavigator(props: {
  tree: SouthstarBranchNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  hasSession?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const activePath = useMemo(() => buildActivePath(props.tree, props.activeLeafId), [props.tree, props.activeLeafId]);
  const branched = hasBranch(props.tree);
  const activeLabel = findNode(props.tree, props.activeLeafId)?.label ?? "Branches";

  return (
    <div className="ss-native-branch">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span aria-hidden="true">Y</span>
        <strong>{shortLabel(activeLabel, 52)}</strong>
        <small>{branched ? "branch history" : props.hasSession ? "linear session" : "new session"}</small>
      </button>
      {open ? (
        <div className="ss-native-branch-menu">
          {props.tree.length > 0 ? (
            props.tree.map((node) => (
              <BranchRow
                key={node.id}
                node={node}
                depth={0}
                activeLeafId={props.activeLeafId}
                activePath={activePath}
                onLeafChange={props.onLeafChange}
              />
            ))
          ) : (
            <p>{props.hasSession ? "This session has no branches." : "No active session."}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BranchRow(props: {
  node: SouthstarBranchNode;
  depth: number;
  activeLeafId: string | null;
  activePath: Set<string>;
  onLeafChange: (leafId: string | null) => void;
}) {
  const isActive = props.node.id === props.activeLeafId;
  const isOnPath = props.activePath.has(props.node.id);
  return (
    <div>
      <button
        type="button"
        className={isActive ? "ss-native-branch-row ss-active" : "ss-native-branch-row"}
        style={{ paddingLeft: 10 + props.depth * 14 }}
        onClick={() => props.onLeafChange(props.node.id)}
      >
        <span className={isOnPath ? "ss-branch-dot ss-on-path" : "ss-branch-dot"} />
        {props.node.role ? <small>{props.node.role === "assistant" ? "A" : props.node.role === "user" ? "U" : "S"}</small> : null}
        <span>{shortLabel(props.node.label, 76)}</span>
      </button>
      {(props.node.children ?? []).map((child) => (
        <BranchRow
          key={child.id}
          node={child}
          depth={props.depth + 1}
          activeLeafId={props.activeLeafId}
          activePath={props.activePath}
          onLeafChange={props.onLeafChange}
        />
      ))}
    </div>
  );
}

function hasBranch(nodes: SouthstarBranchNode[]): boolean {
  return nodes.some((node) => (node.children?.length ?? 0) > 1 || hasBranch(node.children ?? []));
}

function buildActivePath(nodes: SouthstarBranchNode[], activeLeafId: string | null): Set<string> {
  if (!activeLeafId) return new Set();
  const found = findPath(nodes, activeLeafId, []);
  return new Set(found ?? []);
}

function findPath(nodes: SouthstarBranchNode[], target: string, parents: string[]): string[] | null {
  for (const node of nodes) {
    const path = [...parents, node.id];
    if (node.id === target) return path;
    const childPath = findPath(node.children ?? [], target, path);
    if (childPath) return childPath;
  }
  return null;
}

function findNode(nodes: SouthstarBranchNode[], target: string | null): SouthstarBranchNode | null {
  if (!target) return null;
  for (const node of nodes) {
    if (node.id === target) return node;
    const child = findNode(node.children ?? [], target);
    if (child) return child;
  }
  return null;
}

function shortLabel(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}
