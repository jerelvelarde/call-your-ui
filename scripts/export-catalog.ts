/**
 * Writes `server/agent/inference-catalog.json`: the A2UI 1.0 catalog the UI agent's
 * Express compiler and prompt read, exported from the same `standardUI` the browser
 * renders, so the catalog id and component names match.
 *
 * It is the playground's inference catalog without its own components and macros: the
 * standard components with their styling props left out (the browser still accepts them,
 * the theme does the rest) and their descriptions cut to the first sentence. A shorter
 * catalog is a shorter prompt, and the voice is waiting.
 *
 *   pnpm catalog:export     (runs before `dev` and `build`)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { exportA2UICatalog, standardUI } from "@/lib/cpk";

type Schema = Record<string, unknown>;

/** Styling knobs a model does not need to read (from the playground's prompt-trim.ts). */
const STYLE_PROPS = new Set([
  "background",
  "border",
  "borderColor",
  "radius",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "flex",
  "weight",
  "aspectRatio",
  "scrollable",
  "clip",
  "shadow",
  "shadowStyle",
  "inline",
  "role",
  "flush",
  "minSize",
  "maxSize",
  "disableAutoSpacing",
  "rowGap",
  "columnGap",
  "checks",
  "name",
  "fontSize",
  "lineHeight",
  "minLines",
  "maxLines",
  "truncate",
  "preserveWhitespace",
  "italic",
  "underline",
  "lineThrough",
  "highlight",
  "position",
  "hoverZoom",
  "frame",
  "fit",
  "fallback",
  "hideOnFailure",
  "uniform",
  "pill",
  "autoSelect",
  "mask",
  "padding",
]);

const firstSentence = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;

const catalog = exportA2UICatalog(standardUI, {
  title: "Realtime Gen UI",
  description: "Views that answer a spoken question: comparisons, plans, dashboards, forms.",
});

const components = Object.fromEntries(
  Object.entries(catalog.components as Record<string, Schema>).map(([name, schema]) => {
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const properties = Object.fromEntries(
      Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {}).filter(
        ([key]) => required.has(key) || !STYLE_PROPS.has(key),
      ),
    );
    const description =
      typeof schema.description === "string" ? firstSentence(schema.description) : undefined;
    return [name, { ...schema, ...(description ? { description } : {}), properties }];
  }),
);

const inference = { ...catalog, components };

const out = join(__dirname, "../server/agent/inference-catalog.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(inference, null, 1)}\n`);
console.log(
  `inference catalog ${inference.catalogId}: ${Object.keys(components).length} components, ${
    Object.keys(catalog.functions).length
  } functions -> ${relative(process.cwd(), out)}`,
);
