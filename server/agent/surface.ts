/**
 * Gen UI 2.0 surfaces, written by the agent itself.
 *
 * Every view is one `generative-ui-surface` activity message carrying A2UI 1.0 operations,
 * the same events the runtime's `render_ui` tool would emit: an ACTIVITY_SNAPSHOT that
 * creates it, then ACTIVITY_DELTA patches that append operations and flip its status. The
 * client validates and applies each operation as it lands, so the view paints while it
 * streams. A redraw patches the activity message of an earlier run (same surface id, same
 * message id), so the view changes in place.
 */
import {
  A2UI_VERSION,
  GENERATIVE_UI_ACTIVITY_TYPE,
  GENERATIVE_UI_CHAT_TARGET,
  generativeUISurfaceMessageId,
} from "@copilotkit/shared";
import type {
  A2UIComponentNode,
  A2UIOperation,
  GenerativeUISurfaceContent,
  GenerativeUISurfaceStatus,
} from "@copilotkit/shared";
import { EventType } from "./events";
import type { EventQueue } from "./events";

export type Node = A2UIComponentNode;

/** One surface as the thread holds it: what the composer needs to redraw it. */
export type SurfaceRecord = {
  surfaceId: string;
  catalogId: string;
  components: Node[];
  data: Record<string, unknown>;
};

type Patch = Array<{ op: "add" | "replace"; path: string; value: unknown }>;

export class SurfaceStream {
  readonly messageId: string;
  private status: GenerativeUISurfaceStatus | undefined;

  constructor(
    private q: EventQueue,
    readonly surfaceId: string,
    readonly catalogId: string,
  ) {
    this.messageId = generativeUISurfaceMessageId(surfaceId);
  }

  /** Whether the surface is still marked streaming (created or reopened, not yet closed). */
  get open() {
    return this.status === "streaming";
  }

  /** Creates the surface: a new activity message with an empty `createSurface`. */
  create() {
    const content: GenerativeUISurfaceContent = {
      surfaceId: this.surfaceId,
      target: GENERATIVE_UI_CHAT_TARGET,
      catalogId: this.catalogId,
      operations: [
        {
          version: A2UI_VERSION,
          createSurface: { surfaceId: this.surfaceId, catalogId: this.catalogId },
        },
      ],
      status: "streaming",
      rejected: [],
    };
    this.status = "streaming";
    this.q.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: this.messageId,
      activityType: GENERATIVE_UI_ACTIVITY_TYPE,
      content,
      replace: true,
    });
  }

  /** Reopens a surface from an earlier run: it streams again and starts with no rejections. */
  reopen() {
    this.status = "streaming";
    this.patch([
      { op: "replace", path: "/status", value: "streaming" },
      { op: "replace", path: "/rejected", value: [] },
    ]);
  }

  /** Adds or replaces components by id. */
  upsert(...components: Node[]) {
    if (components.length)
      this.append({
        version: A2UI_VERSION,
        updateComponents: { surfaceId: this.surfaceId, components },
      });
  }

  /** Sets `value` at `path` of the data model ("/" replaces all of it). */
  data(value: unknown, path = "/") {
    this.append({
      version: A2UI_VERSION,
      updateDataModel: { surfaceId: this.surfaceId, path, value },
    });
  }

  /** Marks the surface ready (or failed, which the renderer shows as an error on the card). */
  close(status: Exclude<GenerativeUISurfaceStatus, "streaming"> = "ready") {
    this.status = status;
    this.patch([{ op: "replace", path: "/status", value: status }]);
  }

  private append(operation: A2UIOperation) {
    this.patch([{ op: "add", path: "/operations/-", value: operation }]);
  }

  private patch(patch: Patch) {
    this.q.push({
      type: EventType.ACTIVITY_DELTA,
      messageId: this.messageId,
      activityType: GENERATIVE_UI_ACTIVITY_TYPE,
      patch,
    });
  }
}
