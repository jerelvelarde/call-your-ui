import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildInstructions, runToolCall, toRealtimeTools } from "@/lib/copilot-call/tool-bridge";
import type { FrontendTool, ScopedContext } from "@/lib/cpk";

const moveTool: FrontendTool<any> = {
  name: "move_stop",
  description: "Move a stop.",
  parameters: z.object({ stopId: z.string(), time: z.string().optional(), extra: z.object({ a: z.number() }).optional() }),
  handler: async (args) => `moved ${(args as { stopId: string }).stopId}`,
};

function hasKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (key in (value as object)) return true;
  return Object.values(value as object).some((v) => hasKey(v, key));
}

describe("toRealtimeTools", () => {
  it("maps a zod tool to a Realtime function tool without $schema or additionalProperties", () => {
    const [tool] = toRealtimeTools([moveTool]);
    expect(tool).toMatchObject({ type: "function", name: "move_stop", description: "Move a stop." });
    expect(tool.parameters.type).toBe("object");
    expect(Object.keys(tool.parameters.properties as object)).toEqual(["stopId", "time", "extra"]);
    expect(hasKey(tool.parameters, "$schema")).toBe(false);
    expect(hasKey(tool.parameters, "additionalProperties")).toBe(false);
  });

  it("gives a tool without parameters an empty object schema", () => {
    const [tool] = toRealtimeTools([{ name: "ping", handler: async () => "pong" }]);
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("skips unavailable, handler-less, other-agent and badly named tools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tools: FrontendTool<any>[] = [
      { ...moveTool, name: "off", available: false },
      { name: "render_only" },
      { ...moveTool, name: "other_agent", agentId: "other" },
      { ...moveTool, name: "mine", agentId: "default" },
      { ...moveTool, name: "has space" },
      moveTool,
    ];
    expect(toRealtimeTools(tools, "default").map((t) => t.name)).toEqual(["mine", "move_stop"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("buildInstructions", () => {
  const context: Record<string, ScopedContext> = {
    a: { description: "Trip plan", value: "d1 (Fri)" },
    b: { description: "Other agent only", value: "secret", agentIds: ["other"] },
    c: { description: "Today's date", value: "2026-11-18 (Wed)", agentIds: ["default"] },
  };

  it("appends only applicable context entries, in order", () => {
    expect(buildInstructions("Be brief.", context, "default")).toBe(
      "Be brief.\n\n# Context\n## Trip plan\nd1 (Fri)\n\n## Today's date\n2026-11-18 (Wed)",
    );
  });

  it("returns the base alone when no context applies", () => {
    expect(buildInstructions("Be brief.", { b: context.b })).toBe("Be brief.");
  });
});

const call = (name: string, args: unknown) => ({ call_id: "call_1", name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const opts = () => ({ signal: new AbortController().signal, deadlineMs: 1_000 });

describe("runToolCall", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the handler result and passes validated args and the tool call", async () => {
    const seen: unknown[] = [];
    const tool: FrontendTool<any> = {
      ...moveTool,
      handler: async (args, ctx) => {
        seen.push(args, ctx.toolCall);
        return "moved s4";
      },
    };
    const out = await runToolCall(tool, call("move_stop", { stopId: "s4" }), opts());
    expect(out).toEqual({ ok: true, output: JSON.stringify({ result: "moved s4" }) });
    expect(seen[0]).toEqual({ stopId: "s4" });
    expect(seen[1]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "move_stop", arguments: JSON.stringify({ stopId: "s4" }) },
    });
  });

  it("reports unknown tools, bad JSON and schema errors without calling the handler", async () => {
    const handler = vi.fn(async () => "x");
    const tool = { ...moveTool, handler };
    expect(await runToolCall(undefined, call("nope", {}), opts())).toEqual({
      ok: false,
      output: JSON.stringify({ error: 'Unknown tool "nope".' }),
    });
    expect(await runToolCall(tool, call("move_stop", "{oops"), opts())).toEqual({
      ok: false,
      output: JSON.stringify({ error: "The arguments were not valid JSON." }),
    });
    const invalid = await runToolCall(tool, call("move_stop", { stopId: 4 }), opts());
    expect(invalid.ok).toBe(false);
    expect(JSON.parse(invalid.output).error).toMatch(/^Invalid arguments: stopId: /);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never starts the handler when the call already ended", async () => {
    const outer = new AbortController();
    outer.abort();
    const handler = vi.fn(async () => "x");
    const out = await runToolCall({ ...moveTool, handler }, call("move_stop", { stopId: "s1" }), { signal: outer.signal, deadlineMs: 1_000 });
    expect(out.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("turns a throw into an error output", async () => {
    const tool = { ...moveTool, handler: async () => { throw new Error("boom"); } };
    expect(await runToolCall(tool, call("move_stop", { stopId: "s1" }), opts())).toEqual({
      ok: false,
      output: JSON.stringify({ error: "boom" }),
    });
  });

  it("stops at the deadline and aborts the handler's signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const tool: FrontendTool<any> = {
      ...moveTool,
      handler: (_args, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    };
    const pending = runToolCall(tool, call("move_stop", { stopId: "s1" }), { signal: new AbortController().signal, deadlineMs: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(JSON.parse(out.output).error).toBe("The tool took longer than 5s and was stopped.");
    expect(signal?.aborted).toBe(true);
  });

  it("aborts the handler when the call's own signal aborts", async () => {
    const outer = new AbortController();
    let signal: AbortSignal | undefined;
    const tool: FrontendTool<any> = {
      ...moveTool,
      handler: (_args, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {});
      },
    };
    const pending = runToolCall(tool, call("move_stop", { stopId: "s1" }), { signal: outer.signal, deadlineMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 0)); // the handler is running
    expect(signal?.aborted).toBe(false);
    outer.abort();
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
});
