/**
 * The composer: one model call that writes a view in A2UI Express, painted while it streams.
 *
 * The model writes one statement per component. `@a2ui/agent` compiles the reply as it
 * arrives, and each finished statement goes to the browser at once as an `updateComponents`
 * operation, so the view builds up component by component while the voice keeps talking.
 * A child that is named but not written yet renders nothing until it arrives (the
 * CopilotKit renderer's own placeholder), so no stand-in component is sent for it.
 *
 * A reply that does not compile gets one retry that quotes the compiler's error for the
 * whole reply. The retry is applied once it compiles, not painted line by line.
 *
 * A redraw writes to the same surface id: the model is given the view as it is now, as
 * Express, and its rewrite replaces the components by id, so the view changes in place.
 */
import type { AgentToRendererMessage, StreamPart } from "@a2ui/agent";
import type { EventQueue } from "./events";
import {
  expressProcessor,
  expressPromptSnippet,
  messagesOf,
  openExpressStream,
  surfaceOf,
  toExpress,
} from "./express";
import { PlainError } from "./model";
import type { ChatMessage, ModelStream } from "./model";
import { SurfaceStream } from "./surface";
import type { Node, SurfaceRecord } from "./surface";

export type ComposeInput = {
  /** What to draw, or for a redraw, what to change. */
  brief: string;
  surfaceId: string;
  catalogId: string;
  /** Redraw: the surface as it is now. It is rewritten in place under the same id. */
  prior?: SurfaceRecord;
  q: EventQueue;
  model: ModelStream;
  signal: AbortSignal;
};

export type ComposeResult = {
  /** The view as it now is: what a later redraw starts from. */
  surface: SurfaceRecord;
  /** Whether the first reply did not compile and the retry was used. */
  retried: boolean;
  /** ms from the start of the call to the first painted component, when one painted while streaming. */
  firstPaintMs?: number;
};

const RULES = `You write the view that answers a voice assistant's request, in A2UI Express, with the components below. The user hears a short spoken answer and looks at your view. Reply with exactly one <a2ui> block and nothing else: no prose, no code fence, no surface() line.

WRITING ORDER (the view paints line by line while you write)
- First line: root = Column(...) or another container. Then each parent before its children, in reading order.
- One component per line, named for what it is (title, price_row, book_button). Never nest a component call inside another; reference it by name.
- Put values inline as literals. Use $/path bindings only for the values of inputs, seeded with $/path = value lines at the end.
- Leave out an optional argument you have no value for; never write null. After one you skip, name the rest (size="sm").

CONTENT
- Everything shows inside the view: a heading is a Title, a paragraph is a Text. Nothing outside the block is shown.
- Realistic, concrete content from the brief: real names, prices, dates, numbers with units. Never placeholders.
- Only the controls the brief asks for, plus obvious ones (a form gets its submit button).
- Every Button carries an action: an Event named for what it does, with the context it needs, e.g. Event("book_room", {room: "Deluxe King"}).
- Compact: one screen, no filler, no heading that repeats the request.`;

let system: string | undefined;
/** The system prompt: the rules above, then the Express contract and signatures generated from the catalog. */
export function systemPrompt(): string {
  system ??= `${RULES}\n\n${expressPromptSnippet()}`;
  return system;
}

/** How the user message opens: a new view, or a redraw (a REDRAW_MARKER brief or a click). */
export const NEW_VIEW_PREFIX = "Write this view:";
export const REDRAW_PREFIX = "Change the view on screen:";
/** The heading above the current view's Express in a redraw's user message. */
export const VIEW_ON_SCREEN = "The view on screen now:";
/** How agent.ts opens the brief of a click on a view. */
export const CLICK_BRIEF_PREFIX = "The user pressed";

/** The user message: the brief, and for a redraw the view as it is now. */
export function userMessage(input: Pick<ComposeInput, "brief" | "prior">): string {
  if (!input.prior) return `${NEW_VIEW_PREFIX} ${input.brief}`;
  const { surfaceId, catalogId, components, data } = input.prior;
  return [
    `${REDRAW_PREFIX} ${input.brief}`,
    `${VIEW_ON_SCREEN}\n<a2ui>\n${toExpress(surfaceId, catalogId, components, data).trim()}\n</a2ui>`,
    "Write the whole updated view as one <a2ui> block. Keep its layout, names and every part the change does not touch.",
  ].join("\n\n");
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Reply = { text: string; parsed: AgentToRendererMessage[]; error?: unknown };

export async function compose(input: ComposeInput): Promise<ComposeResult> {
  const { q, surfaceId, catalogId, prior, signal } = input;
  const startedAt = performance.now();
  const stream = new SurfaceStream(q, surfaceId, catalogId);
  if (prior) stream.reopen();
  else stream.create();

  /** What the browser holds for each component id, so a component goes out only when it changed. */
  const sent = new Map<string, string>(prior?.components.map((c) => [c.id, JSON.stringify(c)]));
  let sentData = prior ? JSON.stringify(prior.data) : "{}";
  let changed = false;
  let firstPaintMs: number | undefined;

  const send = (components: Node[]) => {
    const fresh = components.filter((c) => sent.get(c.id) !== JSON.stringify(c));
    for (const c of fresh) sent.set(c.id, JSON.stringify(c));
    if (!fresh.length) return;
    stream.upsert(...fresh);
    changed = true;
  };
  /** A redraw keeps the values already on screen (what the user typed) unless the rewrite sets them. */
  const dataOf = (data: Record<string, unknown>) => (prior ? { ...prior.data, ...data } : data);
  const sendData = (data: Record<string, unknown>) => {
    const json = JSON.stringify(data);
    if (json === sentData || !Object.keys(data).length) return;
    sentData = json;
    stream.data(data);
    changed = true;
  };
  const paint = (parsed: AgentToRendererMessage[]) => {
    const { components, data } = surfaceOf(parsed);
    sendData(dataOf(data));
    send(components);
    if (firstPaintMs === undefined && components.length)
      firstPaintMs = Math.round(performance.now() - startedAt);
  };

  const write = async (messages: ChatMessage[], live: boolean): Promise<Reply> => {
    let text = "";
    // A redraw paints only finished statements: a component the rewrite keeps compiles to
    // what is already on screen and is not sent again, instead of flickering as its text
    // streams back in.
    const express = openExpressStream(surfaceId, !prior);
    const parsed: AgentToRendererMessage[] = [];
    let error: unknown;
    // The first block the SDK rejects ends the reading: the view stops painting there, and
    // `error` is what the retry tells the model.
    const read = (parts: () => StreamPart[]) => {
      if (error) return;
      try {
        const ready = parts();
        const rejected = ready.find((part) => part.type === "error");
        if (rejected?.type === "error") error = rejected.error;
        const fresh = messagesOf(ready);
        if (!fresh.length) return;
        parsed.push(...fresh);
        if (live) paint(parsed);
      } catch (err) {
        error = err;
      }
    };
    for await (const delta of input.model(messages, signal)) {
      signal.throwIfAborted();
      text += delta;
      read(() => express.feed(delta));
    }
    signal.throwIfAborted();
    // Closing an unfinished block is an error too: a cut-off reply is not finished silently.
    read(() => express.close());
    // The stream can place a syntax error on the wrong line (it depends on where the chunks
    // split), so the error the retry quotes comes from compiling the whole reply. If the whole
    // reply compiles after all, it is used as it is.
    if (error) {
      try {
        const whole = messagesOf(expressProcessor(surfaceId).parseResponse(text));
        if (whole.length) {
          parsed.splice(0, parsed.length, ...whole);
          error = undefined;
        }
      } catch (err) {
        error = err;
      }
    }
    if (!error && !parsed.length) error = new Error("The reply has no <a2ui> block.");
    if (!error && !surfaceOf(parsed).components.some((c) => c.id === "root"))
      error = new Error("The reply has no root component (root = ...).");
    return { text, parsed, error };
  };

  try {
    const conversation: ChatMessage[] = [
      { role: "system", content: systemPrompt() },
      { role: "user", content: userMessage(input) },
    ];
    let reply = await write(conversation, true);
    let retried = false;
    if (reply.error) {
      retried = true;
      const message = errorText(reply.error);
      console.warn(`[ui-agent] ${surfaceId}: Express did not compile, retrying: ${message}`);
      conversation.push(
        { role: "assistant", content: reply.text },
        {
          role: "user",
          content: `That did not compile: ${message}\nReply with the whole corrected <a2ui> block.`,
        },
      );
      reply = await write(conversation, false);
      if (reply.error)
        throw new PlainError(
          `The UI writer's reply did not compile after a retry: ${errorText(reply.error)}`,
        );
    }

    const { components, data } = surfaceOf(reply.parsed);
    const finalData = dataOf(data);
    sendData(finalData);
    send(components);
    stream.close("ready");
    return {
      surface: { surfaceId, catalogId, components, data: finalData },
      retried,
      ...(firstPaintMs === undefined ? {} : { firstPaintMs }),
    };
  } catch (err) {
    // Never leave the view streaming. A stopped run keeps what painted; a redraw that changed
    // nothing leaves the view as it was; anything else is marked failed.
    if (stream.open) stream.close(signal.aborted || (prior && !changed) ? "ready" : "error");
    throw err;
  }
}
