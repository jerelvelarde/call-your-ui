# Call Your UI

Call your app. Talk, and the screen changes.

A desktop trip planner you can phone. Press **Call** and say *"Plan me three days in Lisbon, Friday to Sunday"*, and the plan fills in. *"Move the castle to Saturday morning"* slides the card over. *"Roughly what's this going to cost?"* draws a cost breakdown under the plan. *"Put it on my calendar, starting Friday the eleventh"* turns the days into a calendar.

The voice is OpenAI's GPT Realtime. The edits are ordinary [CopilotKit](https://github.com/CopilotKit/CopilotKit) frontend tools: the same `useFrontendTool` tools a CopilotKit chat would call. A small hook, `useCopilotCall`, hands every registered tool and every piece of agent context to the voice session, runs the tools the voice calls, and sends the results back.

## Run it

You need Node 22+, pnpm 10 and an OpenAI API key with Realtime access.

```bash
git clone https://github.com/jerelvelarde/call-your-ui
cd call-your-ui
cp .env.example .env.local   # then add your OPENAI_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3300, press **Call** and allow the microphone.

## How it works

```
you ── voice (WebRTC) ──▶ GPT Realtime
                            │  move_stop({ stopId: "s4", toDayId: "d2", time: "09:00" })
                            ▼
                     useCopilotCall ──▶ CopilotKit's tool registry ──▶ your handler ──▶ the plan changes
                            ▲                                                            │
                            └──────── the result, plus the updated plan as context ◀─────┘
```

1. The app registers its edits with `useFrontendTools` and shares the plan with `useAgentContext` ([components/use-trip-tools.ts](components/use-trip-tools.ts)). Nothing there knows about voice.
2. `POST /api/realtime/session` mints a short-lived client secret. Your OpenAI key never reaches the browser.
3. `useCopilotCall` opens the call and sends a `session.update` with the tools (converted from their schemas) and the instructions, with CopilotKit's context appended. It sends a new one whenever the context changes, so the voice always sees what's on screen.
4. When the model calls a tool, the hook validates the arguments against the tool's schema and runs its handler with a deadline and an abort signal. It returns the result. Several calls in one turn run together and get one response.
5. `show_panel` sends anything the plan can't show by itself to a CopilotKit agent that writes [A2UI](https://github.com/google/A2UI), and the panel renders under the plan.

## Use it in your own CopilotKit app

[`lib/copilot-call/`](lib/copilot-call) has no app code in it: its only import from the app is [`lib/cpk.ts`](lib/cpk.ts), which re-exports CopilotKit. Copy those two and the session route ([app/api/realtime/session/route.ts](app/api/realtime/session/route.ts)) into a CopilotKit 2 app, and your frontend tools work over a call:

```tsx
import { useCopilotCall } from "@/lib/copilot-call";

function CallButton() {
  const call = useCopilotCall({ instructions: "You are the voice of this app. Keep replies short." });
  return call.status === "idle" ? <button onClick={call.start}>Call</button> : <button onClick={call.stop}>Hang up</button>;
}
```

| Returns | |
|---|---|
| `status` | `idle`, `connecting`, `listening`, `thinking`, `running-tool`, `speaking` or `error` |
| `transcript` | What the caller and the voice said, with partial and final entries |
| `error`, `muted`, `startedAt` | Call state for your UI |
| `start()`, `stop()`, `setMuted()`, `sendText()` | Control the call; `sendText` adds a typed message mid-call |
| `getLevels()` | Mic and voice loudness (0–1), for a waveform |

Options: `instructions`, `agentId` (which agent-scoped tools and context to use), `sessionUrl`, `toolDeadlineMs` (60 s by default) and `maxCallMs` (10 minutes by default).

## Limits

- It's turn-based. Edits land a moment after you pause, not mid-sentence: GPT Realtime decides when you've finished talking.
- Places and prices come from the model's own knowledge. Costs are estimates, and the UI says so.
- OpenAI bills every minute a call is open. Calls hang up on their own after 10 minutes (the browser enforces this).
- `/api/realtime/session` checks that the request comes from the app's own page and rate-limits each IP. Those are speed bumps, not security, and `/api/copilotkit` (the panel writer) has neither. Both spend your OpenAI key, so before you deploy this anywhere public, put real authentication in front of the whole app.

## Tests

- `pnpm test` runs the unit tests: the trip model, the tool bridge, the call loop and the session route. No network.
- `pnpm e2e:voice && pnpm e2e` makes a real call against `pnpm dev` with a synthesized caller. It plays each line of the demo script into a fake microphone, checks the plan after each one, and saves a screen recording to `e2e/takes/`. It needs `OPENAI_API_KEY`.

## Built with

CopilotKit 2.0 (release candidate), A2UI, OpenAI GPT Realtime, Next.js and Motion.

## License

MIT
