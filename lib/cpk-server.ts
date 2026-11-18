/**
 * Every server-side CopilotKit import goes through this file (see lib/cpk.ts for why).
 * On 1.88 these were `CopilotRuntime` / `createCopilotRuntimeHandler` from `@copilotkit/runtime/v2`
 * and `BuiltInAgent` from the same path.
 */
export { CopilotKitRuntime, createCopilotKitRuntimeHandler } from "@copilotkit/runtime";
export { BuiltInAgent } from "@copilotkit/runtime/agent";
