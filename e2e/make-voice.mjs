// Writes e2e/voice/line-{1..5}.wav (mono, 24 kHz) from e2e/lines.json: the caller's side of the call.
// ElevenLabs when ELEVENLABS_API_KEY is set (in the environment or .env.local), else macOS `say`.
// Usage: node e2e/make-voice.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "e2e/voice");
const lines = JSON.parse(fs.readFileSync(path.join(ROOT, "e2e/lines.json"), "utf8"));

function envFile() {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env.local"), "utf8")
        .split("\n")
        .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
    );
  } catch {
    return {};
  }
}
const env = { ...envFile(), ...process.env };
const key = env.ELEVENLABS_API_KEY;
const voice = env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

/** A WAV header around 16-bit mono PCM. */
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function eleven(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_24000`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return wav(Buffer.from(await res.arrayBuffer()), 24000);
}

function say(text, out) {
  const tmp = path.join(os.tmpdir(), `cyui-${process.pid}.aiff`);
  execFileSync("say", ["-v", "Samantha", "-r", "185", "-o", tmp, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  fs.rmSync(tmp, { force: true });
}

fs.mkdirSync(OUT, { recursive: true });
console.log(key ? `ElevenLabs voice ${voice}` : "macOS say (Samantha); set ELEVENLABS_API_KEY for ElevenLabs");
for (const [i, text] of lines.entries()) {
  const out = path.join(OUT, `line-${i + 1}.wav`);
  if (key) fs.writeFileSync(out, await eleven(text));
  else say(text, out);
  const seconds = Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString(),
  );
  console.log(`line ${i + 1}: ${seconds.toFixed(2)}s  ${text}`);
}
