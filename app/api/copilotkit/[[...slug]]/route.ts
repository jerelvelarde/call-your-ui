/**
 * The CopilotKit runtime: serves the UI agent at /api/copilotkit.
 *
 * `generativeUI: false`: the agent writes its own `generative-ui-surface` activities, so the
 * runtime must not add its `render_ui` tool. The browser still sends its catalog in the
 * generative UI envelope, and a click on a view arrives there as an A2UI action.
 */
import { COPILOTKIT_RUNTIME_URL, UI_AGENT_ID } from "@/lib/config";
import { CopilotKitRuntime, createCopilotKitRuntimeHandler } from "@/lib/cpk-server";
import { createUiAgent } from "@/server/agent/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const copilotRuntime = new CopilotKitRuntime({
  agents: { [UI_AGENT_ID]: createUiAgent() },
  generativeUI: false,
});

const handler = createCopilotKitRuntimeHandler({
  runtime: copilotRuntime,
  basePath: COPILOTKIT_RUNTIME_URL,
});

export const GET = handler;
export const POST = handler;
