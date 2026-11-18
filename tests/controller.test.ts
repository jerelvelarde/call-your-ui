import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCallController } from "@/lib/copilot-call/controller";
import type { CallStatus, TranscriptEntry } from "@/lib/copilot-call/controller";
import type { RealtimeClientEvent, RealtimeServerEvent } from "@/lib/copilot-call/events";
import type { FrontendTool, ScopedContext } from "@/lib/cpk";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** One log of everything the controller sends: `send:<type>` or `turn:[a,b,c]`. */
function label(e: RealtimeClientEvent): string {
  if (e.type === "conversation.item.create") {
    return e.item.type === "function_call_output" ? `output:${e.item.call_id}` : "text";
  }
  return e.type;
}

function harness(tools: FrontendTool<any>[], context: Record<string, ScopedContext> = {}) {
  const log: string[] = [];
  const sent: RealtimeClientEvent[] = [];
  const turns: RealtimeClientEvent[][] = [];
  const statuses: CallStatus[] = [];
  const transcript: TranscriptEntry[] = [];
  const errors: string[] = [];
  const controller = createCallController({
    send: (e) => {
      sent.push(e);
      log.push(`send:${e.type}`);
    },
    turn: (...events) => {
      turns.push(events);
      log.push(`turn:[${events.map(label).join(",")}]`);
    },
    getTools: () => tools,
    getContext: () => context,
    instructions: "Be brief.",
    toolDeadlineMs: 1_000,
    onStatus: (s) => statuses.push(s),
    onTranscript: (entry) => transcript.push(entry),
    onError: (m) => errors.push(m),
  });
  return { controller, log, sent, turns, statuses, transcript, errors };
}

const tool = (name: string, handler: FrontendTool<any>["handler"]): FrontendTool<any> => ({
  name,
  description: `${name} tool`,
  parameters: z.object({ id: z.string() }),
  handler,
});

const fnCall = (callId: string, name: string, args: unknown, status: "completed" | "incomplete" = "completed") => ({
  type: "function_call" as const,
  id: `item_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
  status,
});

const done = (...output: ReturnType<typeof fnCall>[]): RealtimeServerEvent => ({
  type: "response.done",
  response: { id: "resp_1", status: "completed", output },
});

describe("createCallController", () => {
  it("open sends one session.update with instructions, context and tools", () => {
    const h = harness([tool("move_stop", async () => "ok")], { a: { description: "Trip plan", value: "d1 (Fri)" } });
    h.controller.open();
    expect(h.sent).toHaveLength(1);
    const update = h.sent[0] as { type: string; session: Record<string, unknown> };
    expect(update.type).toBe("session.update");
    expect(update.session.type).toBe("realtime");
    expect(update.session.tool_choice).toBe("auto");
    expect(update.session.instructions).toBe("Be brief.\n\n# Context\n## Trip plan\nd1 (Fri)");
    expect((update.session.tools as { name: string }[]).map((t) => t.name)).toEqual(["move_stop"]);
    h.controller.syncSession();
    expect(h.sent).toHaveLength(1);
  });

  it("answers every call in a response with one response.create", async () => {
    const ran: string[] = [];
    const h = harness([
      tool("move_stop", async (args) => {
        ran.push(`move ${(args as { id: string }).id}`);
        return "moved";
      }),
      tool("update_stop", async (args) => {
        ran.push(`update ${(args as { id: string }).id}`);
        return "updated";
      }),
    ]);
    h.controller.open();
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" }), fnCall("b", "update_stop", { id: "s5" })));
    await flush();
    expect(ran.sort()).toEqual(["move s4", "update s5"]);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].map(label)).toEqual(["output:a", "output:b", "response.create"]);
    const outputs = h.turns[0].slice(0, 2) as { item: { output: string } }[];
    expect(outputs.map((o) => JSON.parse(o.item.output))).toEqual([{ result: "moved" }, { result: "updated" }]);
  });

  it("skips incomplete function calls", async () => {
    let ran = 0;
    const h = harness([tool("move_stop", async () => (ran++, "ok"))]);
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" }, "incomplete")));
    await flush();
    expect(ran).toBe(0);
    expect(h.turns).toEqual([]);
  });

  it("runs a repeated call_id once", async () => {
    let ran = 0;
    const h = harness([tool("move_stop", async () => (ran++, "ok"))]);
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" })));
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" })));
    await flush();
    expect(ran).toBe(1);
    expect(h.turns).toHaveLength(1);
  });

  it("answers an unknown tool with an error output", async () => {
    const h = harness([]);
    h.controller.handle(done(fnCall("a", "nope", {})));
    await flush();
    expect(JSON.parse((h.turns[0][0] as { item: { output: string } }).item.output)).toEqual({ error: 'Unknown tool "nope".' });
  });

  it("sends session.update before the tool outputs when context changed", async () => {
    const context: Record<string, ScopedContext> = { a: { description: "Trip plan", value: "empty" } };
    const h = harness(
      [
        tool("move_stop", async () => {
          context.a = { description: "Trip plan", value: "d1 (Fri): s4 moved" };
          return "moved";
        }),
      ],
      context,
    );
    h.controller.open();
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" })));
    await flush();
    expect(h.log).toEqual(["send:session.update", "send:session.update", "turn:[output:a,response.create]"]);
    const second = h.sent[1] as unknown as { session: { instructions: string } };
    expect(second.session.instructions).toContain("s4 moved");
  });

  it("dispose aborts running handlers and sends nothing after", async () => {
    let signal: AbortSignal | undefined;
    const h = harness([
      tool("show_panel", (_args, ctx) => {
        signal = ctx.signal;
        return new Promise((resolve) => ctx.signal?.addEventListener("abort", () => resolve("stopped")));
      }),
    ]);
    h.controller.open();
    h.controller.handle(done(fnCall("a", "show_panel", { id: "x" })));
    await flush();
    h.controller.dispose();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(h.turns).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });

  it("status goes running-tool → thinking → speaking → listening", async () => {
    const h = harness([tool("move_stop", async () => "ok")]);
    h.controller.handle(done(fnCall("a", "move_stop", { id: "s4" })));
    expect(h.statuses.at(-1)).toBe("running-tool");
    await flush();
    h.controller.handle({ type: "response.created", response: { id: "resp_2" } });
    h.controller.handle({ type: "output_audio_buffer.started" });
    h.controller.handle({ type: "output_audio_buffer.stopped" });
    expect(h.statuses.slice(-4)).toEqual(["running-tool", "thinking", "speaking", "listening"]);
  });

  it("a completed user transcription becomes a final user entry", () => {
    const h = harness([]);
    h.controller.handle({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.controller.handle({ type: "conversation.item.input_audio_transcription.delta", item_id: "u1", delta: "Move the " });
    h.controller.handle({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      transcript: "Move the castle to Saturday.",
    });
    const last = h.transcript.at(-1)!;
    expect(last).toMatchObject({ id: "u1", role: "user", text: "Move the castle to Saturday.", final: true });
    expect(h.transcript[0]).toMatchObject({ id: "u1", text: "Move the ", final: false });
  });

  it("reports a failed response and a server error, but not a refused response.create", () => {
    const h = harness([]);
    h.controller.handle({
      type: "response.done",
      response: { id: "r", status: "failed", status_details: { error: { message: "Rate limit reached." } } },
    });
    h.controller.handle({ type: "error", error: { code: "conversation_already_has_active_response", message: "busy" } });
    h.controller.handle({ type: "error", error: { message: "Invalid tool schema." } });
    expect(h.errors).toEqual(["Rate limit reached.", "Invalid tool schema."]);
  });

  it("sendText adds a final user entry and asks for a response", () => {
    const h = harness([]);
    h.controller.sendText("  Make it cheaper  ");
    expect(h.turns[0].map(label)).toEqual(["text", "response.create"]);
    expect(h.transcript.at(-1)).toMatchObject({ role: "user", text: "Make it cheaper", final: true });
  });
});
