# Realtime Gen UI

Talk to GPT Realtime, and the answer draws itself. When an answer has structure (a comparison, a plan, a dashboard, a form), the voice hands a short brief to a CopilotKit agent. That agent writes A2UI, and the view streams onto the page one component at a time while the voice keeps talking. Press a button on a view and it updates in place, and the voice hears about it.

Built on the team's latest work:

- **CopilotKit 2.0** (`2.0.0-rc.53`, the `next` tag on npm): the runtime, `useAgent`, and the generative UI renderer with the standard catalog.
- **The A2UI Playground** (`examples/showcases/a2ui-playground` in CopilotKit/CopilotKit, live at a2ui.open.bot). Its UI agent is ported here: A2UI Express streamed through `@a2ui/agent` 0.1.0, one compile retry, and a view record so later redraws can find the view.

## How it works

```
 you speak ──▶ GPT Realtime (browser, WebRTC)
                 │ says "Putting that up now"
                 │ calls show_ui({ brief, target })
                 ▼
            useUiAgent.draw()  ──▶  /api/copilotkit  ──▶  UI agent (A2UI Express, streamed)
                 │                                          │
                 │            ◀── generative-ui-surface activity, one component at a time
                 ▼
            the view paints on the stage
                 │
                 └──▶ function_call_output { status: "shown" } ──▶ the voice says one line

 a click on a view ──▶ CopilotKit reruns the agent ──▶ the same view is redrawn in place
                   └──▶ "[UI] …" goes to the voice, which acknowledges it
```

- The voice model never writes UI. It writes a brief, and the UI agent writes the A2UI. Voice models are tuned for talking; this keeps them fast and keeps the UI good.
- The tool result waits for the view to finish, so the voice's follow-up line lands after the view does.
- `target: "current"` redraws the view on screen ("make it a chart instead").

## Run it

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp .env.example .env.local      # then set OPENAI_API_KEY
pnpm dev                        # http://localhost:3200
```

Tap the orb and allow the microphone. Or type in the box: with the voice on, typing talks to the voice; with it off, typing goes straight to the UI writer.

The first request after `pnpm dev` compiles the runtime and the A2UI compiler, which can take around 30 seconds. After that, views start painting in about 1–2 seconds.

### Offline mode (no key, no network)

```bash
COMPOSER_MODEL=offline pnpm dev
```

The UI writer draws canned views for the four suggestions on the empty stage (headphones, a Lisbon trip, a sales dashboard, a signup form). It streams at a model-like pace, and a click on each updates the view, for example "Order confirmed". Anything else draws a short note. It is opt-in only: a missing key never falls back to it. The voice still needs a key.

### Settings (`.env.local`)

| Variable | Default | |
| --- | --- | --- |
| `OPENAI_API_KEY` | (required) | One key runs both the voice and the UI writer. |
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | `gpt-realtime-2.1` is the step up if briefs come out thin. |
| `REALTIME_VOICE` | `marin` | `cedar` is OpenAI's other recommended voice. |
| `COMPOSER_MODEL` | `gpt-5.6-sol` | The UI writer. `gpt-6-astra` is the step up, `gpt-5.6-luna` the cheap one, `offline` the canned writer. |
| `COMPOSER_REASONING` | `low` | Reasoning effort for the UI writer. |
| `COPILOTKIT_TELEMETRY_DISABLED` | | `true` turns off the runtime's usage telemetry. |

## Checks

```bash
pnpm typecheck
pnpm test        # smoke-compose, smoke-sequencer, smoke-offline, smoke-abort (all offline)
pnpm build
```

## Where things are

| Path | What |
| --- | --- |
| `app/api/realtime/token/route.ts` | Mints a 10-minute Realtime client secret with the session config. The real key never reaches the browser. |
| `lib/realtime/` | The WebRTC client, the response sequencer (one response at a time), the draw deadline and the `useRealtime` hook. |
| `app/api/copilotkit/[[...slug]]/route.ts` | The CopilotKit 2.0 runtime with the UI agent. |
| `server/agent/` | The UI agent: brief → A2UI Express → streamed surface operations, plus the offline writer. |
| `components/use-ui-agent.ts` | Runs the UI agent from the page, one draw at a time, and spots clicks. |
| `components/` | The rail (orb, captions, briefs), the stage and the provider. |
| `lib/cpk.ts`, `lib/cpk-server.ts` | Every CopilotKit import. If the 2.0 RC breaks, only these change for 1.88 (`/v2` paths). |
| `lib/config.ts` | Model defaults, the voice's instructions and the `show_ui` tool. |
| `BLUEPRINT.md` | The build contract the app was built from. |
