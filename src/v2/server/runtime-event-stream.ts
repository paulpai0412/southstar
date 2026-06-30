import type { RuntimeServerContext } from "./runtime-context.ts";
import { parseRuntimeEventSequence, readRunEventsSince, TERMINAL_RUNTIME_EVENT_TYPES, toSseFrame, toSseHeartbeatFrame } from "./sse.ts";

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 30_000;
const MIN_HEARTBEAT_INTERVAL_MS = 10;
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "passed", "failed", "cancelled"]);

export function createRuntimeEventStreamResponse(context: RuntimeServerContext, request: Request, url: URL, runId: string): Response {
  const initialAfter = parseAfterSequence(url, request);
  const closeOnTerminal = url.searchParams.get("closeOnTerminal") !== "false";
  const taskId = url.searchParams.get("taskId") ?? undefined;
  const includeRunEvents = url.searchParams.get("includeRunEvents") !== "false";
  const stream = createRuntimeEventStream(context, request, {
    runId,
    taskId,
    includeRunEvents,
    afterSequence: initialAfter,
    closeOnTerminal,
    pollIntervalMs: parsePositiveBoundedInteger(url.searchParams.get("pollMs"), {
      fallback: DEFAULT_POLL_INTERVAL_MS,
      min: MIN_POLL_INTERVAL_MS,
      max: MAX_POLL_INTERVAL_MS,
    }),
    heartbeatIntervalMs: parsePositiveBoundedInteger(url.searchParams.get("heartbeatMs"), {
      fallback: DEFAULT_HEARTBEAT_INTERVAL_MS,
      min: MIN_HEARTBEAT_INTERVAL_MS,
      max: MAX_HEARTBEAT_INTERVAL_MS,
    }),
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      ...corsHeaders(),
    },
  });
}

function createRuntimeEventStream(
  context: RuntimeServerContext,
  request: Request,
  input: {
    runId: string;
    taskId?: string;
    includeRunEvents: boolean;
    afterSequence: number;
    closeOnTerminal: boolean;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let nextAfter = input.afterSequence;
  let lastHeartbeatAt = Date.now();
  let removeAbortListener: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;
        removeAbortListener?.();
        removeAbortListener = undefined;
      };
      const safeClose = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {
          // The consumer may already have canceled the stream.
        }
      };
      const safeEnqueue = (value: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(value));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      const safeError = (error: unknown) => {
        if (closed) return;
        cleanup();
        try {
          controller.error(error);
        } catch {
          // The stream may already be closed by abort/cancel.
        }
      };
      const abort = () => safeClose();
      request.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => request.signal.removeEventListener("abort", abort);
      if (request.signal.aborted) {
        safeClose();
        return;
      }

      const schedule = () => {
        if (closed) return;
        timer = setTimeout(tick, input.pollIntervalMs);
      };

      const tick = async () => {
        if (closed) return;
        try {
          const events = await readRunEventsSince(context.db, {
            runId: input.runId,
            taskId: input.taskId,
            includeRunEvents: input.includeRunEvents,
            afterSequence: nextAfter,
          });
          if (closed) return;
          for (const event of events) {
            if (!safeEnqueue(toSseFrame(event))) return;
            nextAfter = event.sequence;
          }

          if (input.closeOnTerminal && events.some((event) => TERMINAL_RUNTIME_EVENT_TYPES.has(event.eventType))) {
            safeClose();
            return;
          }
          if (input.closeOnTerminal && await isRunTerminal(context, input.runId)) {
            safeClose();
            return;
          }

          const now = Date.now();
          if (events.length === 0 && now - lastHeartbeatAt >= input.heartbeatIntervalMs) {
            if (!safeEnqueue(toSseHeartbeatFrame(new Date(now).toISOString()))) return;
            lastHeartbeatAt = now;
          }
          if (input.closeOnTerminal && await shouldCloseTerminalReconnect(context, input.runId, nextAfter, closed)) {
            if (closed) return;
            const finalEvents = await readRunEventsSince(context.db, {
              runId: input.runId,
              taskId: input.taskId,
              includeRunEvents: input.includeRunEvents,
              afterSequence: nextAfter,
            });
            if (closed) return;
            for (const event of finalEvents) {
              if (!safeEnqueue(toSseFrame(event))) return;
              nextAfter = event.sequence;
            }
            safeClose();
            return;
          }
          schedule();
        } catch (error) {
          safeError(error);
        }
      };

      void tick();
    },
    cancel() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      removeAbortListener?.();
      removeAbortListener = undefined;
    },
  });
}

function parseAfterSequence(url: URL, request: Request): number {
  // SSE reconnects resume from Last-Event-ID when present; query after is the initial stream cursor.
  return parseRuntimeEventSequence(request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0");
}

async function isRunTerminal(context: RuntimeServerContext, runId: string): Promise<boolean> {
  const row = await context.db.maybeOne<{ status: string }>(
    "select status from southstar.workflow_runs where id = $1",
    [runId],
  );
  return row ? TERMINAL_RUN_STATUSES.has(row.status) : true;
}

async function shouldCloseTerminalReconnect(context: RuntimeServerContext, runId: string, nextAfter: number, closed: boolean): Promise<boolean> {
  if (closed || !await isRunTerminal(context, runId)) return false;
  const row = await context.db.maybeOne<{ sequence: number }>(
    `select sequence
       from southstar.workflow_history
      where run_id = $1
        and sequence <= $2
        and event_type = any($3::text[])
      order by sequence desc
      limit 1`,
    [runId, nextAfter, [...TERMINAL_RUNTIME_EVENT_TYPES]],
  );
  return Boolean(row);
}

function parsePositiveBoundedInteger(value: string | null, input: { fallback: number; min: number; max: number }): number {
  if (!value || !/^(0|[1-9]\d*)$/.test(value)) return input.fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < input.min || parsed > input.max) return input.fallback;
  return parsed;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,last-event-id",
  };
}
