/**
 * Every browser-side CopilotKit import goes through this file. CopilotKit 2.0 is a release
 * candidate (pinned to 2.0.0-rc.53); falling back to 1.88 means changing only these paths
 * to their `/v2` forms (`@copilotkit/react-core/v2`, `@copilotkit/react-core/v2/generative-ui`).
 */
export {
  CopilotKitProvider,
  useAgent,
  useAgentContext,
  useCopilotKit,
  useFrontendTools,
  useRenderActivityMessage,
} from "@copilotkit/react-core";
export type { CopilotKitProviderProps, FrontendTool, ScopedContext } from "@copilotkit/react-core";
export {
  GenerativeUISurface,
  createGenerativeUI,
  exportA2UICatalog,
  standardUI,
} from "@copilotkit/react-core/generative-ui";
