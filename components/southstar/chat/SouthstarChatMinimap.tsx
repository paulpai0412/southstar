"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

export type SouthstarChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp?: string;
};

export function SouthstarChatMinimap(props: {
  messages: SouthstarChatMessage[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<Array<HTMLDivElement | null>>;
}) {
  const [scrollRatio, setScrollRatio] = useState(0);
  const [viewportRatio, setViewportRatio] = useState(1);
  const [nodes, setNodes] = useState<Array<{ topRatio: number; message: SouthstarChatMessage; index: number }>>([]);
  const [visible, setVisible] = useState(false);
  const dragging = useRef(false);

  const visibleMessages = useMemo(
    () => props.messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [props.messages],
  );

  const updatePositions = useCallback(() => {
    const element = props.scrollContainer.current;
    if (!element) return;
    const totalHeight = element.scrollHeight;
    const clientHeight = element.clientHeight;
    const scrollable = totalHeight - clientHeight;
    setVisible(scrollable > 24 && visibleMessages.length > 1);
    setScrollRatio(scrollable > 0 ? element.scrollTop / scrollable : 0);
    setViewportRatio(totalHeight > 0 ? Math.min(1, clientHeight / totalHeight) : 1);
    const containerTop = element.getBoundingClientRect().top;
    const nextNodes = props.messageRefs.current
      .map((node, index) => {
        const message = visibleMessages[index];
        if (!node || !message || totalHeight <= 0) return null;
        return {
          topRatio: (node.getBoundingClientRect().top - containerTop + element.scrollTop) / totalHeight,
          message,
          index,
        };
      })
      .filter((node): node is { topRatio: number; message: SouthstarChatMessage; index: number } => node !== null);
    setNodes(nextNodes);
  }, [props.messageRefs, props.scrollContainer, visibleMessages]);

  useEffect(() => {
    const element = props.scrollContainer.current;
    if (!element) return;
    element.addEventListener("scroll", updatePositions, { passive: true });
    const resizeObserver = new ResizeObserver(updatePositions);
    resizeObserver.observe(element);
    if (element.firstElementChild) resizeObserver.observe(element.firstElementChild);
    updatePositions();
    return () => {
      element.removeEventListener("scroll", updatePositions);
      resizeObserver.disconnect();
    };
  }, [props.scrollContainer, updatePositions]);

  useEffect(() => {
    const timer = setTimeout(updatePositions, 30);
    return () => clearTimeout(timer);
  }, [props.messages.length, updatePositions]);

  const scrollToMinimapRatio = useCallback((ratio: number) => {
    const element = props.scrollContainer.current;
    if (!element) return;
    const scrollable = element.scrollHeight - element.clientHeight;
    if (scrollable <= 0) return;
    const maxTopRatio = Math.max(0, 1 - viewportRatio);
    const clamped = Math.max(0, Math.min(maxTopRatio, ratio));
    element.scrollTop = maxTopRatio > 0 ? (clamped / maxTopRatio) * scrollable : 0;
  }, [props.scrollContainer, viewportRatio]);

  const onPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height);
    scrollToMinimapRatio(ratio - viewportRatio / 2);
  }, [scrollToMinimapRatio, viewportRatio]);

  if (!visible) return null;

  return (
    <div
      className="ss-native-minimap"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) onPointer(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
    >
      <div className="ss-native-minimap-line" />
      <div
        className="ss-native-minimap-viewport"
        style={{ top: `${scrollRatio * (1 - viewportRatio) * 100}%`, height: `${viewportRatio * 100}%` }}
      />
      {nodes.map((node) => (
        <button
          type="button"
          key={node.message.id}
          className={node.message.role === "user" ? "ss-native-minimap-node ss-user" : "ss-native-minimap-node"}
          style={{ top: `${node.topRatio * 100}%` }}
          title={node.message.text}
          onClick={() => props.messageRefs.current[node.index]?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
      ))}
    </div>
  );
}

export function useSouthstarMessageRefs(count: number): RefObject<Array<HTMLDivElement | null>> {
  const messageRefs = useRef<Array<HTMLDivElement | null>>([]);
  messageRefs.current = Array.from({ length: count }, (_item, index) => messageRefs.current[index] ?? null);
  return messageRefs;
}
