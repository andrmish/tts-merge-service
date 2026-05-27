import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const app = express();
const upload = multer({ dest: os.tmpdir() });

const SAMPLE_RATE = 44100;
const CHANNELS = 1;

// Настройки стыков
const GAP_SECONDS = 0.34;      // пауза между фрагментами
const FADE_SECONDS = 0.025;    // мягкий fade-in / fade-out

function runFfmpeg(args) {
  console.log("ffmpeg", args.join(" "));
  execFileSync("ffmpeg", args, { stdio: "inherit" });
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
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

    console.log(
      "Received files:",
      files.map(f => ({
        originalname: f.originalname,
        size: f.size,
        mimetype: f.mimetype
      }))
    );

    const processedWavs = [];

    // 1. Каждый входной WAV приводим к единому виду:
    // mono 44100, выравнивание громкости, мягкая динамика, fade edges.
    for (let i = 0; i < files.length; i++) {
      const input = files[i].path;

      const wav = path.join(
        workDir,
        `part_${String(i + 1).padStart(4, "0")}.wav`
      );

      runFfmpeg([
        "-y",
        "-i", input,
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-af",
        [
          "loudnorm=I=-20:TP=-3:LRA=7",
          "acompressor=threshold=-22dB:ratio=1.25:attack=25:release=180",
          "alimiter=limit=0.90",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse"
        ].join(","),
        wav
      ]);

      processedWavs.push(wav);
    }

    // 2. Создаём нейтральную паузу между фрагментами
    const gapWav = path.join(workDir, "gap.wav");

    runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono:d=${GAP_SECONDS}`,
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      gapWav
    ]);

    // 3. Собираем concat list:
    // part1 + gap + part2 + gap + part3...
    const concatListPath = path.join(workDir, "concat.txt");
    const concatLines = [];

    for (let i = 0; i < processedWavs.length; i++) {
      concatLines.push(`file '${escapeConcatPath(processedWavs[i])}'`);

      if (i < processedWavs.length - 1) {
        concatLines.push(`file '${escapeConcatPath(gapWav)}'`);
      }
    }

    fs.writeFileSync(concatListPath, concatLines.join("\n"));

    const mergedWav = path.join(workDir, "merged.wav");

    runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", concatListPath,
      "-c", "copy",
      mergedWav
    ]);

    // 4. Финальный MP3 export
    const finalMp3 = path.join(workDir, "final.mp3");

    runFfmpeg([
      "-y",
      "-i", mergedWav,
      "-af",
      "acompressor=threshold=-20dB:ratio=1.2:attack=30:release=220,loudnorm=I=-16:TP=-1.5:LRA=9,alimiter=limit=0.95",
      "-codec:a", "libmp3lame",
      "-b:a", "192k",
      finalMp3
    ]);

    const outputBuffer = fs.readFileSync(finalMp3);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", "attachment; filename=merged.mp3");
    res.send(outputBuffer);

  } catch (err) {
    console.error("MERGE ERROR:", err);

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
