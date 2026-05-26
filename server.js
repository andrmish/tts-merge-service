import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const app = express();
const upload = multer({ dest: os.tmpdir() });

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const CROSSFADE_SECONDS = 0.05;

function runFfmpeg(args) {
  execFileSync("ffmpeg", args, { stdio: "inherit" });
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/merge", upload.array("files"), async (req, res) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-merge-"));

  try {
    const files = req.files || [];

    if (!files.length) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    files.sort((a, b) =>
      a.originalname.localeCompare(b.originalname, undefined, {
        numeric: true,
        sensitivity: "base"
      })
    );

    const wavFiles = [];

    for (let i = 0; i < files.length; i++) {
      const input = files[i].path;
      const wav = path.join(workDir, `part_${String(i + 1).padStart(4, "0")}.wav`);

      runFfmpeg([
        "-y",
        "-f", "s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-i", input,
        "-af",
        "silenceremove=start_periods=1:start_duration=0.03:start_threshold=-50dB:detection=peak,areverse,silenceremove=start_periods=1:start_duration=0.03:start_threshold=-50dB:detection=peak,areverse",
        wav
      ]);

      wavFiles.push(wav);
    }

    let current = wavFiles[0];

    for (let i = 1; i < wavFiles.length; i++) {
      const next = wavFiles[i];
      const output = path.join(workDir, `merged_${String(i).padStart(4, "0")}.wav`);

      runFfmpeg([
        "-y",
        "-i", current,
        "-i", next,
        "-filter_complex",
        `[0:a][1:a]acrossfade=d=${CROSSFADE_SECONDS}:c1=exp:c2=exp`,
        output
      ]);

      current = output;
    }

    const finalMp3 = path.join(workDir, "final.mp3");

    runFfmpeg([
      "-y",
      "-i", current,
      "-af",
      "acompressor=threshold=-18dB:ratio=1.35:attack=20:release=120,loudnorm=I=-16:TP=-1.5:LRA=11",
      "-codec:a", "libmp3lame",
      "-b:a", "192k",
      finalMp3
    ]);

    const outputBuffer = fs.readFileSync(finalMp3);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", "attachment; filename=merged.mp3");
    res.send(outputBuffer);

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message
    });
  } finally {
    try {
      for (const file of req.files || []) {
        fs.unlinkSync(file.path);
      }
    } catch {}

    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("TTS merge service running");
});
