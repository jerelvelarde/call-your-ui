/**
 * The AG-UI event queue a run writes to while the runtime reads it.
 *
 * The BuiltInAgent's custom factory returns this queue as the run's event stream. The
 * runtime wraps it in RUN_STARTED / RUN_FINISHED, and turns an error the stream throws
 * into RUN_ERROR with the error's message: `fail(error)` is how a run ends as failed.
 */
import { EventType } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/client";
import { randomUUID } from "node:crypto";

export { EventType };
export const uid = () => randomUUID();

type Pending = { resolve: (r: IteratorResult<BaseEvent>) => void; reject: (e: unknown) => void };

/** A small async queue so the run can emit AG-UI events while the runtime iterates them. */
export class EventQueue implements AsyncIterable<BaseEvent> {
  private buf: BaseEvent[] = [];
  private waiters: Pending[] = [];
  private closed = false;
  private error: unknown;

  push(e: Record<string, unknown> & { type: EventType }) {
    if (this.closed) return;
    const ev = e as unknown as BaseEvent;
    const w = this.waiters.shift();
    if (w) w.resolve({ value: ev, done: false });
    else this.buf.push(ev);
  }

  /** Ends the stream once the buffered events are read. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  /** Ends the stream with an error once the buffered events are read: the runtime emits RUN_ERROR. */
  fail(error: unknown) {
    if (this.closed) return;
    this.error = error ?? new Error("The run failed.");
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.reject(this.error);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BaseEvent> {
    while (true) {
      if (this.buf.length) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.error !== undefined) throw this.error;
        return;
      }
      const r = await new Promise<IteratorResult<BaseEvent>>((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
      if (r.done) return;
      yield r.value;
    }
  }
}

/** One complete assistant text message. */
export function sayText(q: EventQueue, text: string) {
  const messageId = uid();
  q.push({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
  q.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text });
  q.push({ type: EventType.TEXT_MESSAGE_END, messageId });
}

/** A tool call the agent made and answered itself, in one go. */
export function recordToolCall(q: EventQueue, name: string, args: unknown, result: unknown) {
  const toolCallId = uid();
  q.push({
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName: name,
    parentMessageId: uid(),
  });
  q.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) });
  q.push({ type: EventType.TOOL_CALL_END, toolCallId });
  q.push({
    type: EventType.TOOL_CALL_RESULT,
    messageId: uid(),
    toolCallId,
    role: "tool",
    content: JSON.stringify(result),
  });
}
