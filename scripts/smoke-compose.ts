/**
 * Offline proof of the UI agent: no key, no network. A canned A2UI Express reply streams in
 * small chunks from a fake model, and the events that come out are checked.
 *
 *   pnpm exec tsx --tsconfig tsconfig.json scripts/smoke-compose.ts
 *
 * 1. compose(): one ACTIVITY_SNAPSHOT of a generative-ui-surface, at least 2 ACTIVITY_DELTA
 *    before the final status, the final status "ready", and painting while the reply streams.
 * 2. The agent, run through the BuiltInAgent: a new view, then a REDRAW_MARKER redraw and a
 *    click (A2UI action) that both rewrite the same surface in place, a missing key, a reply
 *    that never compiles, a retry that does, and a stopped run.
 */
import { lastValueFrom, toArray } from "rxjs";
import type { BaseEvent, Message, RunAgentInput } from "@ag-ui/client";
import { REDRAW_MARKER } from "@/lib/config";
import { createUiAgent, SURFACE_RECORD_TOOL } from "@/server/agent/agent";
import { compose } from "@/server/agent/compose";
import { EventQueue, EventType } from "@/server/agent/events";
import { INFERENCE_CATALOG_ID } from "@/server/agent/express";
import { MISSING_KEY_MESSAGE, openAIModelStream } from "@/server/agent/model";
import type { ChatMessage, ModelStream } from "@/server/agent/model";

/* ───────────────────────── fixtures ───────────────────────── */

const REPLY = `<a2ui>
root = Column([heading, card], gap=4)
heading = Text("Sony WH-1000XM6", size="lg", fontWeight="bold")
card = Card([price, battery, buy])
price = Text("$449, the strongest noise cancelling of the three.")
battery = Text("30 hours of battery with noise cancelling on.")
buy = Button("Buy for $449", Event("buy", {model: "WH-1000XM6"}), variant="primary")
</a2ui>`;

const SOLD_OUT = REPLY.replace(
  'buy = Button("Buy for $449", Event("buy", {model: "WH-1000XM6"}), variant="primary")',
  'buy = Button("Sold out", Event("notify", {model: "WH-1000XM6"}), disabled=true)',
);

const CONFIRMED = REPLY.replace(
  'buy = Button("Buy for $449", Event("buy", {model: "WH-1000XM6"}), variant="primary")',
  'buy = Badge("Order confirmed", color="success")',
);

const BROKEN = `<a2ui>
root = Column([heading])
heading = NoSuchComponent("Sony WH-1000XM6")
</a2ui>`;

/* ───────────────────────── harness ───────────────────────── */

let failures = 0;
function check(ok: unknown, what: string) {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}`);
  }
}

/** Counts the chunks the fake model has sent, so an event can say how far the reply was. */
let chunksSent = 0;

/**
 * A fake model: streams the next of `replies` in 7-character chunks, yielding to the event
 * loop between them (or waiting `delayMs` per chunk).
 */
function fakeModel(replies: string[], seen: ChatMessage[][] = [], delayMs = 0): ModelStream {
  let call = 0;
  return async function* (messages, signal) {
    seen.push(messages.map((m) => ({ ...m })));
    const reply = replies[Math.min(call++, replies.length - 1)];
    for (let i = 0; i < reply.length; i += 7) {
      await new Promise((r) => (delayMs ? setTimeout(r, delayMs) : setImmediate(r)));
      signal.throwIfAborted();
      chunksSent++;
      yield reply.slice(i, i + 7);
    }
  };
}

type Ev = BaseEvent & Record<string, any>;
type Patch = { op: string; path: string; value?: any };

const patchesOf = (events: Ev[]) =>
  events.filter((e) => e.type === EventType.ACTIVITY_DELTA).flatMap((e) => e.patch as Patch[]);
const statusOf = (p: Patch[]) => p.filter((x) => x.path === "/status").map((x) => x.value);
const opsOf = (events: Ev[]) =>
  patchesOf(events)
    .filter((p) => p.op === "add" && p.path === "/operations/-")
    .map((p) => p.value);
const componentsIn = (ops: any[]) =>
  ops.flatMap((o) => o.updateComponents?.components ?? o.createSurface?.components ?? []);

function input(messages: Message[], forwardedProps: unknown = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    state: {},
    messages,
    tools: [],
    context: [],
    forwardedProps,
  };
}

/** Runs the agent once and collects every event, including the RUN_ERROR of a failed run. */
async function runAgent(model: () => ModelStream, messages: Message[], props?: unknown) {
  const agent = createUiAgent({ model });
  const events: Ev[] = [];
  let error: unknown;
  await new Promise<void>((resolve) => {
    agent.run(input(messages, props)).subscribe({
      next: (e) => events.push(e as Ev),
      error: (err) => {
        error = err;
        resolve();
      },
      complete: () => resolve(),
    });
  });
  return { events, error };
}

/** The thread messages a client would hold after a run: its record tool call and text, minus activity messages. */
function historyOf(events: Ev[]): Message[] {
  const out: Message[] = [];
  const start = events.find((e) => e.type === EventType.TOOL_CALL_START);
  const args = events.find((e) => e.type === EventType.TOOL_CALL_ARGS);
  const result = events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  const text = events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
  if (start && args && result) {
    out.push({
      id: start.parentMessageId,
      role: "assistant",
      toolCalls: [
        {
          id: start.toolCallId,
          type: "function",
          function: { name: start.toolCallName, arguments: args.delta },
        },
      ],
    });
    out.push({ id: result.messageId, role: "tool", toolCallId: result.toolCallId, content: result.content });
  }
  if (text) out.push({ id: text.messageId, role: "assistant", content: text.delta });
  return out;
}

/* ───────────────────────── 1. compose() ───────────────────────── */

async function composeContract() {
  console.log("compose(): a new view streams in");
  // Each pushed event is stamped with how many reply chunks the model had sent by then.
  const stamped: Array<{ event: Ev; chunks: number }> = [];
  class StampingQueue extends EventQueue {
    override push(e: Record<string, unknown> & { type: EventType }) {
      stamped.push({ event: e as Ev, chunks: chunksSent });
      super.push(e);
    }
  }
  const q = new StampingQueue();
  chunksSent = 0;
  const totalChunks = Math.ceil(REPLY.length / 7);
  const result = await compose({
    brief: "Show the Sony WH-1000XM6 with its price and a buy button.",
    surfaceId: "view-smoke",
    catalogId: INFERENCE_CATALOG_ID,
    q,
    model: fakeModel([REPLY]),
    signal: new AbortController().signal,
  });
  q.close();
  const events: Ev[] = [];
  for await (const e of q) events.push(e as Ev);

  const snapshots = events.filter((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
  check(snapshots.length === 1, "exactly one ACTIVITY_SNAPSHOT");
  check(snapshots[0]?.activityType === "generative-ui-surface", "its activity type is generative-ui-surface");
  check(snapshots[0]?.content?.target === "chat", 'its target is "chat"');
  check(snapshots[0]?.content?.status === "streaming", "it starts streaming");

  const deltas = events.filter((e) => e.type === EventType.ACTIVITY_DELTA);
  const finalIndex = deltas.findIndex((d) => (d.patch as Patch[]).some((p) => p.path === "/status"));
  check(finalIndex >= 2, `at least 2 ACTIVITY_DELTA before the final status (${finalIndex})`);
  check(finalIndex === deltas.length - 1, "the status patch is the last delta");
  check(statusOf(patchesOf(events)).at(-1) === "ready", 'final status is "ready"');
  check(
    deltas.every((d) => d.messageId === snapshots[0]?.messageId),
    "every delta patches the snapshot's message",
  );

  const firstPaint = stamped.find(
    (s) => s.event.type === EventType.ACTIVITY_DELTA && (s.event.patch as Patch[])[0]?.path === "/operations/-",
  );
  check(
    firstPaint && firstPaint.chunks < totalChunks,
    `painting starts while the reply streams (chunk ${firstPaint?.chunks} of ${totalChunks})`,
  );

  const types = Object.fromEntries(componentsIn(opsOf(events)).map((c: any) => [c.id, c.component]));
  check(
    types.root === "Column" && types.heading === "Text" && types.card === "Card" &&
      types.price === "Text" && types.battery === "Text" && types.buy === "Button",
    `the view has Column, heading Text, Card, two Texts and a Button (${JSON.stringify(types)})`,
  );
  const buy = result.surface.components.find((c) => c.id === "buy") as any;
  check(buy?.onClick?.event?.name === "buy", "the Button carries its action");
  check(!result.retried, "no retry was needed");
}

/* ───────────────────────── 2. the agent ───────────────────────── */

async function agentRuns() {
  console.log("agent: a new view");
  const brief = "Show the Sony WH-1000XM6 with its price and a buy button.";
  const user1: Message = { id: "u1", role: "user", content: brief };
  const first = await runAgent(() => fakeModel([REPLY]), [user1]);
  check(first.events[0]?.type === EventType.RUN_STARTED, "RUN_STARTED first");
  check(first.events.at(-1)?.type === EventType.RUN_FINISHED, "RUN_FINISHED last");
  const snapshot = first.events.find((e) => e.type === EventType.ACTIVITY_SNAPSHOT);
  const surfaceId: string = snapshot?.content?.surfaceId;
  check(surfaceId?.startsWith("view-"), `a new surface (${surfaceId})`);
  const record = first.events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  check(
    JSON.parse(record?.content ?? "{}").surface?.components?.length === 6,
    `the run records the view (${SURFACE_RECORD_TOOL})`,
  );
  const text = first.events.find((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)?.delta as string;
  check(text && text.split(/\s+/).length <= 12, `a short closing text: ${JSON.stringify(text)}`);

  console.log("agent: REDRAW_MARKER rewrites the view in place");
  const history = [user1, ...historyOf(first.events)];
  const seen: ChatMessage[][] = [];
  const redraw = await runAgent(
    () => fakeModel([SOLD_OUT], seen),
    [...history, { id: "u2", role: "user", content: `${REDRAW_MARKER}\nMark it sold out.` }],
  );
  const asked = seen[0]?.[1]?.content ?? "";
  check(!asked.includes(REDRAW_MARKER) && asked.includes("Mark it sold out."), "the marker line is stripped");
  check(asked.includes("Buy for $449"), "the composer is given the view's current components");
  check(!redraw.events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT), "no new surface");
  check(
    redraw.events.filter((e) => e.type === EventType.ACTIVITY_DELTA).every((e) => e.messageId === snapshot?.messageId),
    "every patch goes to the same surface",
  );
  const redrawStatus = statusOf(patchesOf(redraw.events));
  check(redrawStatus[0] === "streaming" && redrawStatus.at(-1) === "ready", "reopened, then ready");
  const changed = componentsIn(opsOf(redraw.events)).map((c: any) => c.id);
  check(changed.length === 1 && changed[0] === "buy", `only the changed component is sent (${changed})`);
  check(redraw.events.at(-1)?.type === EventType.RUN_FINISHED, "RUN_FINISHED");

  console.log("agent: a click on the view redraws it");
  const envelope = {
    "1.0": {
      supportedCatalogIds: [INFERENCE_CATALOG_ID],
      inlineCatalogs: [{ catalogId: INFERENCE_CATALOG_ID, protocolVersion: "1.0", components: {}, functions: {} }],
    },
    metadata: {
      extensions: {
        copilotkit_format: 3,
        copilotkit_transport: "tool",
        copilotkit_targets: [],
        copilotkit_surfaces: { [surfaceId]: { target: "chat" } },
        copilotkit_contextSent: false,
        copilotkit_action: {
          version: "1.0",
          action: {
            name: "buy",
            surfaceId,
            sourceComponentId: "buy",
            timestamp: new Date().toISOString(),
            context: { model: "WH-1000XM6" },
          },
        },
      },
    },
  };
  const clickSeen: ChatMessage[][] = [];
  const click = await runAgent(
    () => fakeModel([CONFIRMED], clickSeen),
    [...history, { id: "u3", role: "user", content: "Buy for $449\n\nmodel: WH-1000XM6" }],
    { copilotkit: { ui: envelope } },
  );
  const clickAsked = clickSeen[0]?.[1]?.content ?? "";
  check(clickAsked.includes('pressed "Buy for $449"') && clickAsked.includes("WH-1000XM6"), "the brief describes the action");
  check(!click.events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT), "no new surface");
  check(
    click.events.filter((e) => e.type === EventType.ACTIVITY_DELTA).every((e) => e.messageId === snapshot?.messageId),
    "the clicked surface changes in place",
  );
  check(
    componentsIn(opsOf(click.events)).some((c: any) => c.id === "buy" && c.component === "Badge"),
    "the button became a confirmation",
  );
  check(statusOf(patchesOf(click.events)).at(-1) === "ready", "ready");

  console.log("agent: a redraw targets the newest view, even after an older one was clicked");
  const userB: Message = { id: "u4", role: "user", content: "Show the Bose QC Ultra." };
  const second = await runAgent(() => fakeModel([REPLY]), [...history, userB]);
  const secondId = second.events.find((e) => e.type === EventType.ACTIVITY_SNAPSHOT)?.content?.surfaceId;
  const thread: Message[] = [
    ...history,
    userB,
    ...historyOf(second.events),
    { id: "u5", role: "user", content: "Buy for $449" },
    ...historyOf(click.events),
    { id: "u6", role: "user", content: `${REDRAW_MARKER}\nMark it sold out.` },
  ];
  const third = await runAgent(() => fakeModel([SOLD_OUT]), thread);
  const thirdTarget = third.events.find((e) => e.type === EventType.ACTIVITY_DELTA)?.messageId;
  check(
    secondId && secondId !== surfaceId && thirdTarget === `genui:${secondId}`,
    `the redraw goes to ${secondId}, not the clicked ${surfaceId}`,
  );

  console.log("agent: no OPENAI_API_KEY");
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const noKey = await runAgent(openAIModelStream, [user1]);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  const runError = noKey.events.find((e) => e.type === EventType.RUN_ERROR);
  check(runError?.message === MISSING_KEY_MESSAGE, `RUN_ERROR: ${JSON.stringify(runError?.message)}`);
  check(!noKey.events.some((e) => e.type === EventType.ACTIVITY_SNAPSHOT), "nothing is drawn");

  console.log("agent: a reply that never compiles");
  const brokenSeen: ChatMessage[][] = [];
  const broken = await runAgent(() => fakeModel([BROKEN], brokenSeen), [user1]);
  const brokenError = broken.events.find((e) => e.type === EventType.RUN_ERROR);
  check(brokenSeen.length === 2, "one retry");
  check(
    brokenSeen[1]?.at(-1)?.content.startsWith("That did not compile:"),
    `the retry quotes the error: ${JSON.stringify(brokenSeen[1]?.at(-1)?.content.split("\n")[0])}`,
  );
  check(brokenError?.message?.startsWith("The UI writer's reply did not compile"), `RUN_ERROR: ${brokenError?.message}`);
  check(statusOf(patchesOf(broken.events)).at(-1) === "error", 'the surface is marked "error", not left streaming');

  console.log("agent: a retry that compiles");
  const retry = await runAgent(() => fakeModel([BROKEN, REPLY]), [user1]);
  check(retry.events.at(-1)?.type === EventType.RUN_FINISHED, "RUN_FINISHED");
  check(statusOf(patchesOf(retry.events)).at(-1) === "ready", "ready");
  check(
    componentsIn(opsOf(retry.events)).some((c: any) => c.id === "buy"),
    "the retried view is applied",
  );

  console.log("agent: a stopped run");
  const agent = createUiAgent({ model: () => fakeModel([REPLY], [], 5) });
  const stopped: Ev[] = [];
  let stoppedError: unknown;
  const done = lastValueFrom(agent.run(input([user1])).pipe(toArray())).then(
    (events) => stopped.push(...(events as Ev[])),
    (err) => (stoppedError = err),
  );
  chunksSent = 0;
  await new Promise((r) => setTimeout(r, 80));
  agent.abortRun();
  await done;
  const chunksAtStop = chunksSent;
  await new Promise((r) => setTimeout(r, 50));
  check(!stoppedError, "the stream completes without an error");
  check(chunksAtStop < Math.ceil(REPLY.length / 7) && chunksSent === chunksAtStop, `the model call stops (${chunksAtStop} chunks)`);
  check(!stopped.some((e) => e.type === EventType.RUN_ERROR || e.type === EventType.RUN_FINISHED), "no RUN_ERROR or RUN_FINISHED");
  check(opsOf(stopped).length > 0, "part of the view painted before the stop");
  check(statusOf(patchesOf(stopped)).at(-1) === "ready", 'what painted is kept, marked "ready"');
  check(!stopped.some((e) => e.type === EventType.TOOL_CALL_START), "nothing is recorded");
}

async function main() {
  await composeContract();
  await agentRuns();
  if (failures) {
    console.log(`FAIL smoke-compose (${failures} failed)`);
    process.exit(1);
  }
  console.log("PASS smoke-compose");
}

main().catch((err) => {
  console.error(err);
  console.log("FAIL smoke-compose");
  process.exit(1);
});
