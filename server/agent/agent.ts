/**
 * The UI agent: a CopilotKit BuiltInAgent in custom-factory mode. One run draws one view.
 *
 *   brief (last user message) ──▶ composer (A2UI Express, streamed) ──▶ generative-ui-surface activity
 *
 * - A brief draws a new view (a new surface).
 * - A brief whose first line is REDRAW_MARKER rewrites the newest view in place.
 * - A click on a view arrives as a run whose generative UI envelope carries the A2UI action;
 *   the clicked view is rewritten in place to reflect it.
 *
 * Every run that draws ends with a record of the view (a tool call the agent answers
 * itself, `ui_view`) and one short text message. The client strips activity messages from
 * the history it sends back (`prepareRunAgentInput` in @ag-ui/client), so the record is how
 * a later redraw finds the view's current components in `input.messages`.
 */
import type { Message, RunAgentInput } from "@ag-ui/client";
import {
  GENERATIVE_UI_ACTIVITY_TYPE,
  envelopeToManifest,
  readCopilotKitUIEnvelope,
} from "@copilotkit/shared";
import { REDRAW_MARKER } from "@/lib/config";
import { BuiltInAgent } from "@/lib/cpk-server";
import type { DrawTarget } from "@/lib/types";
import { CLICK_BRIEF_PREFIX, compose } from "./compose";
import { EventQueue, recordToolCall, sayText, uid } from "./events";
import { INFERENCE_CATALOG_ID, setPath, surfaceOf } from "./express";
import { PlainError, modelErrorMessage, openAIModelStream } from "./model";
import type { ModelStream } from "./model";
import type { Node, SurfaceRecord } from "./surface";

/** The tool name of the record a run leaves of the view it drew. */
export const SURFACE_RECORD_TOOL = "ui_view";

type Manifest = ReturnType<typeof envelopeToManifest>;

/** What a `ui_view` tool result holds. */
type SurfaceRecordResult = { kind: typeof SURFACE_RECORD_TOOL; surface: SurfaceRecord; updated: boolean };

/** One run's request: what to draw, and the view to rewrite when it is a redraw. */
type DrawPlan = {
  source: "brief" | "click";
  target: DrawTarget;
  brief: string;
  prior?: SurfaceRecord;
};

/* ───────────────────────── reading the request ───────────────────────── */

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isSurfaceRecord(v: unknown): v is SurfaceRecord {
  return (
    isRecord(v) &&
    typeof v.surfaceId === "string" &&
    typeof v.catalogId === "string" &&
    Array.isArray(v.components) &&
    isRecord(v.data)
  );
}

/** The view a message holds: a `ui_view` record, or a surface activity if the client sent one. */
function surfaceIn(m: Message): SurfaceRecord | undefined {
  if (m.role === "tool") {
    try {
      const r = JSON.parse(textOf(m.content)) as Partial<SurfaceRecordResult>;
      if (r?.kind === SURFACE_RECORD_TOOL && isSurfaceRecord(r.surface)) return r.surface;
    } catch {
      /* not a record */
    }
    return undefined;
  }
  if (m.role === "activity" && m.activityType === GENERATIVE_UI_ACTIVITY_TYPE) {
    const c = m.content as { surfaceId?: unknown; catalogId?: unknown; operations?: unknown };
    if (typeof c.surfaceId !== "string" || !Array.isArray(c.operations)) return undefined;
    const { components, data } = surfaceOf(c.operations as never);
    return {
      surfaceId: c.surfaceId,
      catalogId: typeof c.catalogId === "string" ? c.catalogId : INFERENCE_CATALOG_ID,
      components,
      data,
    };
  }
  return undefined;
}

/**
 * The latest version of a view in the thread: of `surfaceId`, or, when no id is given, of the
 * most recently created view (the one on top of the stage, even if an older view was redrawn
 * since). A view the client reports deleted or failed is skipped. The values the user set on
 * it (the envelope's surface summary) are laid over its data.
 */
function findSurface(
  messages: Message[],
  manifest: Manifest | undefined,
  surfaceId?: string,
): SurfaceRecord | undefined {
  // A Map keeps the order of first insertion: views in the order they were created, each
  // holding its latest version.
  const views = new Map<string, SurfaceRecord>();
  for (const m of messages) {
    const found = surfaceIn(m);
    if (found && !manifest?.surfaces[found.surfaceId]?.status) views.set(found.surfaceId, found);
  }
  const found = surfaceId ? views.get(surfaceId) : [...views.values()].at(-1);
  if (!found) return undefined;
  let data = structuredClone(found.data);
  for (const [path, value] of Object.entries(manifest?.surfaces[found.surfaceId]?.dataModel ?? {}))
    data = setPath(data, path, value);
  return { ...found, components: found.components as Node[], data };
}

type Action = { name: string; surfaceId: string; sourceComponentId?: string; context: Record<string, unknown> };

/** The A2UI action of a click, from the envelope. The envelope comes from the browser, so every field is checked. */
function actionOf(manifest: Manifest | undefined): Action | undefined {
  const a = (manifest?.action as { action?: unknown } | undefined)?.action;
  if (!isRecord(a) || typeof a.surfaceId !== "string" || !a.surfaceId) return undefined;
  return {
    name: typeof a.name === "string" ? a.name : "action",
    surfaceId: a.surfaceId,
    ...(typeof a.sourceComponentId === "string" ? { sourceComponentId: a.sourceComponentId } : {}),
    context: isRecord(a.context) ? a.context : {},
  };
}

function describeAction(action: Action, said: string): string {
  const what = said.split("\n")[0].trim() || action.name;
  const context = Object.keys(action.context).length ? ` with ${JSON.stringify(action.context)}` : "";
  return `${CLICK_BRIEF_PREFIX} "${what}" on this view (event "${action.name}"${context}). Update the view to show the result of that action, for example a confirmed, selected or expanded state. Keep everything else as it is.`;
}

function plan(input: RunAgentInput, manifest: Manifest | undefined): DrawPlan {
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
  const said = lastUser ? textOf(lastUser.content).trim() : "";
  const messages = input.messages;

  const action = actionOf(manifest);
  if (action) {
    const brief = describeAction(action, said);
    // A clicked view that is not in the thread gets a new view rather than rewriting another one.
    const prior = findSurface(messages, manifest, action.surfaceId);
    return { source: "click", target: prior ? "current" : "new", brief, ...(prior ? { prior } : {}) };
  }

  const [first, ...rest] = said.split("\n");
  if (first.trim() === REDRAW_MARKER || said.startsWith(REDRAW_MARKER)) {
    const brief = (first.trim() === REDRAW_MARKER ? rest.join("\n") : said.slice(REDRAW_MARKER.length)).trim();
    if (!brief) throw new PlainError("The redraw request has no brief.");
    const prior = findSurface(messages, manifest);
    return { source: "brief", target: prior ? "current" : "new", brief, ...(prior ? { prior } : {}) };
  }

  if (!said) throw new PlainError("There is nothing to draw: the last user message is empty.");
  return { source: "brief", target: "new", brief: said };
}

/* ───────────────────────── the run ───────────────────────── */

const words = (s: string, n: number) => {
  const all = s.replace(/\s+/g, " ").trim().split(" ");
  return all.length > n ? `${all.slice(0, n).join(" ")}…` : all.join(" ");
};

/** One short line naming what was drawn, for the thread history: the view's first heading, else the brief. */
function summary(components: Node[], brief: string, updated: boolean): string {
  const heading = components.find(
    (c) => (c.component === "Title" || c.component === "Text") && typeof c.text === "string" && c.text.trim(),
  )?.text as string | undefined;
  const verb = updated ? "Updated" : "Drew";
  if (heading) return `${verb} "${words(heading.replace(/[*_`#]/g, ""), 9)}".`;
  return `${verb} a view: ${words(brief.split(/(?<=[.!?])\s/)[0], 9)}`;
}

async function run(
  input: RunAgentInput,
  signal: AbortSignal,
  q: EventQueue,
  makeModel: () => ModelStream,
) {
  const startedAt = performance.now();
  const envelope = readCopilotKitUIEnvelope(input.forwardedProps);
  const manifest = envelope ? envelopeToManifest(envelope) : undefined;
  const request = plan(input, manifest);
  // A missing key fails here, before anything is drawn.
  const model = makeModel();

  const catalogId = request.prior?.catalogId ?? manifest?.catalogId ?? INFERENCE_CATALOG_ID;
  if (catalogId !== INFERENCE_CATALOG_ID)
    console.warn(
      `[ui-agent] the browser renders catalog ${catalogId}, but the composer writes for ${INFERENCE_CATALOG_ID}. Run pnpm catalog:export.`,
    );
  const surfaceId = request.prior?.surfaceId ?? `view-${uid().slice(0, 8)}`;

  const result = await compose({
    brief: request.brief,
    surfaceId,
    catalogId,
    ...(request.prior ? { prior: request.prior } : {}),
    q,
    model,
    signal,
  });
  if (signal.aborted) return;

  const updated = !!request.prior;
  recordToolCall(
    q,
    SURFACE_RECORD_TOOL,
    { brief: request.brief, target: request.target, source: request.source },
    { kind: SURFACE_RECORD_TOOL, surface: result.surface, updated } satisfies SurfaceRecordResult,
  );
  sayText(q, summary(result.surface.components, request.brief, updated));
  console.info(
    `[ui-agent] ${updated ? "redrew" : "drew"} ${surfaceId} (${request.source}): ${
      result.surface.components.length
    } components, first paint ${result.firstPaintMs ?? "-"} ms, done ${Math.round(
      performance.now() - startedAt,
    )} ms${result.retried ? ", after a retry" : ""}`,
  );
}

/** The model for one run: the OpenAI call, which fails the run when the key is missing. */
function defaultModel(): ModelStream {
  return openAIModelStream();
}

/**
 * The UI agent. `model` replaces the OpenAI call (the smoke test passes a canned stream); it
 * is called once per run, and may throw to fail the run before anything is drawn.
 */
export function createUiAgent(options: { model?: () => ModelStream } = {}): BuiltInAgent {
  const makeModel = options.model ?? defaultModel;
  return new BuiltInAgent({
    type: "custom",
    factory: ({ input, abortSignal }) => {
      const q = new EventQueue();
      run(input, abortSignal, q, makeModel).then(
        () => q.close(),
        (err: unknown) => {
          // A stopped run ends quietly: the runtime sends no RUN_FINISHED or RUN_ERROR for it.
          if (abortSignal.aborted) return q.close();
          if (!(err instanceof PlainError)) console.error("[ui-agent] run failed:", err);
          // The runtime turns the stream's error into RUN_ERROR with this message.
          q.fail(new Error(modelErrorMessage(err)));
        },
      );
      return q;
    },
  });
}
