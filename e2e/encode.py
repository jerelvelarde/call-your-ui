# Encodes a take into the demo video: screencast frames at their real timing (60 fps, 1920 wide), the
# caller's lines where they were played, and the model's recorded voice, mixed to -16 LUFS.
# Usage: python3 e2e/encode.py <take-dir> [out.mp4]
import json, os, subprocess, sys

take = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else os.path.join(take, "call-your-ui-demo.mp4"))
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
frames = sorted(json.load(open(os.path.join(take, "frames.json")))["frames"], key=lambda f: f["ts"])
played = json.load(open(os.path.join(take, "lines.json")))
t0 = frames[0]["ts"] * 1000.0  # CDP frame timestamps are seconds since the epoch

lines = []
for i, f in enumerate(frames):
    dur = max(0.0, frames[i + 1]["ts"] - f["ts"]) if i + 1 < len(frames) else 1.5
    lines.append(f"file 'frames/{f['file']}'\nduration {dur:.6f}")
lines.append(f"file 'frames/{frames[-1]['file']}'")
concat = os.path.join(take, "concat.txt")
open(concat, "w").write("\n".join(lines) + "\n")

inputs = ["-f", "concat", "-safe", "0", "-i", concat]
filters, labels = [], []
for n, line in enumerate(played):
    inputs += ["-i", os.path.join(root, "e2e", "voice", f"line-{line['index'] + 1}.wav")]
    delay = max(0, int(line["startedAt"] - t0))
    filters.append(f"[{n + 1}:a]aresample=48000,adelay={delay}|{delay}[c{n}]")
    labels.append(f"[c{n}]")
remote = os.path.join(take, "remote.webm")
meta = json.load(open(os.path.join(take, "remote.json"))) if os.path.exists(os.path.join(take, "remote.json")) else None
if meta and os.path.exists(remote):
    k = len(played) + 1
    inputs += ["-i", remote]
    delay = max(0, int(meta["startedAt"] - t0))
    filters.append(f"[{k}:a]aresample=48000,adelay={delay}|{delay}[m]")
    labels.append("[m]")
filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[a]")

subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", *inputs,
     "-filter_complex", ";".join(filters),
     "-map", "0:v", "-map", "[a]",
     "-vf", "scale=1920:-2:flags=lanczos", "-fps_mode", "cfr", "-r", "60",
     "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
     "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out],
    check=True,
)
print(out)
