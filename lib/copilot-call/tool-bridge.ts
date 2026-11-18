/**
 * Mirrors CopilotKit's registered frontend tools and agent context into a GPT Realtime session,
 * and runs a tool when the voice model calls it. No app code: this is the piece a CopilotKit
 * voice-call API would ship (the same job CopilotKit's WebMCP bridge does for browser agents).
 */
import { schemaToJsonSchema } from "@copilotkit/shared";
import type { FrontendTool, ScopedContext } from "@/lib/cpk";

export interface RealtimeFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallInput {
  call_id: string;
  name: string;
  /** The arguments as a JSON string, as the model sent them. */
  arguments: string;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Removes every `additionalProperties` key, in place. Some providers reject schemas that carry it. */
function stripAdditionalProperties(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) return schema.forEach(stripAdditionalProperties);
  const record = schema as Record<string, unknown>;
  delete record.additionalProperties;
  Object.values(record).forEach(stripAdditionalProperties);
}

function toolSchema(tool: FrontendTool<any>): Record<string, unknown> {
  if (!tool.parameters) return { type: "object", properties: {} };
  const raw = schemaToJsonSchema(tool.parameters);
  const { $schema: _ignored, ...schema } = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (typeof schema.type !== "string") schema.type = "object";
  if (!schema.properties || typeof schema.properties !== "object") schema.properties = {};
  stripAdditionalProperties(schema);
  return schema;
}

/** The tools the call can use: available, with a handler, and global or scoped to `agentId`. */
export function toRealtimeTools(tools: readonly FrontendTool<any>[], agentId?: string): RealtimeFunctionTool[] {
  const out: RealtimeFunctionTool[] = [];
  for (const tool of tools) {
    if (tool.available === false || !tool.handler) continue;
    if (tool.agentId && tool.agentId !== agentId) continue;
    if (!TOOL_NAME.test(tool.name)) {
      console.warn(`[copilot-call] skipping tool "${tool.name}": names must match ${TOOL_NAME}`);
      continue;
    }
    out.push({ type: "function", name: tool.name, description: tool.description ?? "", parameters: toolSchema(tool) });
  }
  return out;
}

/** The session's instructions: the caller's, then each context entry that applies to `agentId`. */
export function buildInstructions(
  base: string,
  context: Readonly<Record<string, ScopedContext>>,
  agentId?: string,
): string {
  const blocks = Object.values(context)
    .filter((entry) => !entry.agentIds || (agentId !== undefined && entry.agentIds.includes(agentId)))
    .map((entry) => `## ${entry.description}\n${entry.value}`);
  return blocks.length === 0 ? base : `${base}\n\n# Context\n${blocks.join("\n\n")}`;
}

type Outcome = { ok: boolean; output: string };
const fail = (error: string): Outcome => ({ ok: false, output: JSON.stringify({ error }) });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validates the arguments against the tool's schema, if it has one. */
async function validate(tool: FrontendTool<any>, args: unknown): Promise<{ value: unknown } | { error: string }> {
  const standard = tool.parameters?.["~standard"];
  if (!standard) return { value: args };
  const result = await standard.validate(args);
  if (!result.issues) return { value: result.value };
  const issues = result.issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((p) => (typeof p === "object" && p !== null && "key" in p ? String(p.key) : String(p)))
      .join(".");
    return `${path || "(root)"}: ${issue.message}`;
  });
  return { error: `Invalid arguments: ${issues.join("; ")}` };
}

/**
 * Runs one tool call and returns the `function_call_output` text: `{"result": …}` or `{"error": …}`.
 * Never throws. The handler's signal aborts at the deadline or when `opts.signal` does.
 */
export async function runToolCall(
  tool: FrontendTool<any> | undefined,
  call: ToolCallInput,
  opts: { signal: AbortSignal; deadlineMs: number },
): Promise<Outcome> {
  if (!tool?.handler) return fail(`Unknown tool "${call.name}".`);
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return fail("The arguments were not valid JSON.");
  }
  const checked = await validate(tool, args);
  if ("error" in checked) return fail(checked.error);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(opts.signal.reason);
  if (opts.signal.aborted) return fail("The call ended before the tool ran.");
  opts.signal.addEventListener("abort", onOuterAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => {
      const error = `The tool took longer than ${Math.round(opts.deadlineMs / 1000)}s and was stopped.`;
      resolve(fail(error));
      controller.abort(new Error(error));
    }, opts.deadlineMs);
  });
  const ended = new Promise<Outcome>((resolve) => {
    opts.signal.addEventListener("abort", () => resolve(fail("The call ended before the tool finished.")), {
      once: true,
    });
  });
  const run = (async (): Promise<Outcome> => {
    try {
      const result = await tool.handler!(checked.value as Record<string, unknown>, {
        toolCall: { id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } },
        signal: controller.signal,
      });
      return { ok: true, output: JSON.stringify({ result: result ?? null }) };
    } catch (error) {
      return fail(message(error));
    }
  })();

  try {
    return await Promise.race([run, deadline, ended]);
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener("abort", onOuterAbort);
  }
}
