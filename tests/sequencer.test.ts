import { describe, expect, it } from "vitest";
import type { RealtimeClientEvent } from "@/lib/copilot-call/events";
import { createResponseSequencer } from "@/lib/copilot-call/sequencer";

/** A short, readable name per client event, so order is easy to compare. */
function label(e: RealtimeClientEvent): string {
  if (e.type === "conversation.item.create") {
    const item = e.item;
    return item.type === "function_call_output" ? `output:${item.call_id}` : `text:${item.content[0]?.text}`;
  }
  return e.type;
}

const output = (callId: string): RealtimeClientEvent => ({
  type: "conversation.item.create",
  item: { type: "function_call_output", call_id: callId, output: JSON.stringify({ status: "shown" }) },
});
const text = (t: string): RealtimeClientEvent => ({
  type: "conversation.item.create",
  item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
});
const create: RealtimeClientEvent = { type: "response.create" };

function harness() {
  const sent: string[] = [];
  const seq = createResponseSequencer((e) => sent.push(label(e)));
  return { sent, seq };
}

describe("response sequencer", () => {
  it("sends an idle turn at once, in order", () => {
    const { sent, seq } = harness();
    seq.turn(text("hello"), create);
    expect(sent).toEqual(["text:hello", "response.create"]);
  });

  it("holds a turn during an active response until response.done", () => {
    const { sent, seq } = harness();
    seq.handle({ type: "response.created" });
    seq.turn(output("call_1"), create);
    expect(sent).toEqual([]);
    seq.handle({ type: "response.output_audio_transcript.delta" });
    expect(sent).toEqual([]);
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["output:call_1", "response.create"]);
  });

  it("keeps order across several held turns, one response at a time", () => {
    const { sent, seq } = harness();
    seq.handle({ type: "response.created" });
    seq.turn(output("a"), create);
    seq.turn(text("b"), create);
    seq.turn(output("c"), create);
    expect(sent).toEqual([]);
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["output:a", "response.create"]);
    seq.handle({ type: "response.created" });
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["output:a", "response.create", "text:b", "response.create"]);
    seq.handle({ type: "response.created" });
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["output:a", "response.create", "text:b", "response.create", "output:c", "response.create"]);
  });

  it("counts a sent but unanswered response.create as active", () => {
    const { sent, seq } = harness();
    seq.turn(text("one"), create);
    seq.turn(text("two"), create);
    expect(sent).toEqual(["text:one", "response.create"]);
    seq.handle({ type: "response.created" });
    expect(sent).toHaveLength(2);
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["text:one", "response.create", "text:two", "response.create"]);
  });

  it("does not hold the queue for a turn without response.create", () => {
    const { sent, seq } = harness();
    seq.turn(text("note"));
    seq.turn(text("ask"), create);
    expect(sent).toEqual(["text:note", "text:ask", "response.create"]);
  });

  it("resends a create refused because the server's own response won the race", () => {
    const { sent, seq } = harness();
    seq.turn(output("x"), create);
    seq.handle({ type: "response.created" });
    seq.handle({ type: "error", error: { code: "conversation_already_has_active_response" } });
    expect(sent).toEqual(["output:x", "response.create"]);
    seq.handle({ type: "response.done" });
    expect(sent).toEqual(["output:x", "response.create", "response.create"]);
  });

  it("reset drops held turns and the active flag", () => {
    const { sent, seq } = harness();
    seq.handle({ type: "response.created" });
    seq.turn(text("stale"), create);
    seq.reset();
    seq.handle({ type: "response.done" });
    expect(sent).toEqual([]);
    seq.turn(text("fresh"), create);
    expect(sent).toEqual(["text:fresh", "response.create"]);
  });
});
