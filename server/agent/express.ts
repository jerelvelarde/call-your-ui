/**
 * A2UI Express with Google's `@a2ui/agent` SDK.
 *
 * Express is the compact inference format the A2UI SDKs default to: the model writes one
 * statement per component (`price = Text("$349")`), and the SDK compiles it, against the
 * catalog, into standard A2UI 1.0 messages. It needs no tool calling.
 *
 * The SDK also compiles a reply while it streams (`openStream`): each statement comes back
 * as soon as it is complete, which is how the view paints while the model is still writing.
 *
 * The catalog is `inference-catalog.json`, written from `standardUI` by
 * `scripts/export-catalog.ts` (`pnpm catalog:export`, run before dev and build).
 */
import {
  A2uiGenerator,
  CatalogConfig,
  ExpressDecompiler,
  ExpressFormatFactory,
  InMemoryCatalogProvider,
} from "@a2ui/agent";
import type {
  A2uiRequestProcessor,
  AgentToRendererMessage,
  ResponseStream,
  StreamPart,
} from "@a2ui/agent";
import inference from "./inference-catalog.json";
import type { Node } from "./surface";

const doc = inference as unknown as Record<string, unknown> & { catalogId: string };

/** The catalog id the inference catalog was exported with (the standard catalog's). */
export const INFERENCE_CATALOG_ID = doc.catalogId;

/**
 * Renderer capabilities for the processor. The version key is "1.0": the SDK and
 * CopilotKit both use the canonical form, and "v1.0" throws at runtime.
 */
const CAPS = { "1.0": { supportedCatalogIds: [doc.catalogId] } };

/** The messages the composer may write. A view is created or rewritten, never deleted. */
const ALLOWED_MESSAGES = ["createSurface", "updateComponents", "updateDataModel"] as const;

let generators: { main: A2uiGenerator; decompiler: ExpressDecompiler } | undefined;
function sdk() {
  if (!generators) {
    const config = new CatalogConfig(new InMemoryCatalogProvider(doc).load());
    generators = {
      main: new A2uiGenerator([config]),
      decompiler: new ExpressDecompiler(config.catalog, "1.0"),
    };
  }
  return generators;
}

/**
 * A processor for one surface: its prompt snippet, a streaming compiler and a whole-reply
 * parser. With `progressive`, a statement's `text` string streams in before its closing quote
 * (the SDK's default); without it, a statement comes back only once it is complete.
 */
export const expressProcessor = (surfaceId: string, progressive = true): A2uiRequestProcessor =>
  sdk().main.createProcessor(
    CAPS,
    new ExpressFormatFactory({
      surfaceId,
      allowedMessages: ALLOWED_MESSAGES,
      ...(progressive ? {} : { progressiveKeys: [] }),
    }),
  );

/** The Express rules and catalog signatures, for the composer's system prompt. */
let snippet: string | undefined;
export function expressPromptSnippet(): string {
  snippet ??= expressProcessor("prompt").promptSnippet;
  return snippet;
}

/**
 * Compiles a reply as it streams: `feed` each chunk, then `close`. Each returns what it
 * completed: `createSurface` once `root = ...` is written, then each statement's components
 * and data. A rejected block comes back as an error part alongside any completed parts.
 */
export const openExpressStream = (
  surfaceId: string,
  progressive = true,
): ResponseStream<StreamPart> =>
  expressProcessor(surfaceId, progressive).openStream({ afterRejectedBlock: "continue" });

/** The A2UI messages among parsed parts. */
export const messagesOf = (parts: StreamPart[]): AgentToRendererMessage[] =>
  parts.flatMap((p) => (p.type === "a2ui" ? p.a2ui : []));

type Wire = {
  createSurface?: { components?: Node[]; dataModel?: Record<string, unknown> };
  updateComponents?: { components?: Node[] };
  updateDataModel?: { path?: string; value?: unknown };
};

/**
 * Sets `value` at a JSON Pointer `path` of `data` ("/" merges an object into the root) and
 * returns the data. Objects on the way are created; `data` is changed in place.
 */
export function setPath(
  data: Record<string, unknown>,
  path: string | undefined,
  value: unknown,
): Record<string, unknown> {
  const segs = (path ?? "/")
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!segs.length)
    return typeof value === "object" && value && !Array.isArray(value)
      ? { ...data, ...(value as Record<string, unknown>) }
      : data;
  let cur = data;
  for (const s of segs.slice(0, -1))
    cur = (cur[s] = typeof cur[s] === "object" && cur[s] ? cur[s] : {}) as Record<string, unknown>;
  cur[segs[segs.length - 1]] = value;
  return data;
}

/** Components (last definition of each id wins) and data model after a list of compiled messages. */
export function surfaceOf(messages: AgentToRendererMessage[]): {
  components: Node[];
  data: Record<string, unknown>;
} {
  const byId = new Map<string, Node>();
  let data: Record<string, unknown> = {};
  for (const m of messages as unknown as Wire[]) {
    for (const c of m.createSurface?.components ?? m.updateComponents?.components ?? [])
      byId.set(c.id, c);
    if (m.createSurface?.dataModel) data = { ...data, ...m.createSurface.dataModel };
    if (m.updateDataModel) data = setPath(data, m.updateDataModel.path, m.updateDataModel.value);
  }
  return { components: [...byId.values()], data };
}

/**
 * A surface's components and data as Express: what the composer reads when it redraws a
 * view. Falls back to JSON when the decompiler cannot write it.
 */
export function toExpress(
  surfaceId: string,
  catalogId: string,
  components: Node[],
  data: Record<string, unknown>,
): string {
  const message = {
    version: "1.0",
    createSurface: {
      surfaceId,
      catalogId,
      components,
      ...(Object.keys(data).length ? { dataModel: data } : {}),
    },
  } as unknown as AgentToRendererMessage;
  try {
    // Keyword arguments read better than positional `_` placeholders, and the surface is
    // implied, so its `surface(...)` line goes.
    return sdk()
      .decompiler.decompile([message], true)
      .split("\n")
      .filter((line) => !/^surface\(/.test(line.trim()))
      .join("\n");
  } catch {
    return JSON.stringify({ components, data });
  }
}
