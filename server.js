import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawnSync } from "child_process";

const app = express();
const upload = multer({ dest: os.tmpdir() });

const SAMPLE_RATE = 44100;
const CHANNELS = 1;

// Пауза между уже очищенными фрагментами
const GAP_SECONDS = 0.34;

// Fade edges
const FADE_SECONDS = 0.025;

// Как искать длинную служебную паузу после intro
const INTRO_SEARCH_SECONDS = 10;      // искать только в первых 10 сек файла
const INTRO_SILENCE_MIN = 0.75;       // длинная пауза минимум 750 ms
const INTRO_SILENCE_DB = "-38dB";     // чувствительность тишины
const CUT_AFTER_SILENCE_PAD = 0.05;   // оставить 50 ms после конца паузы

function runFfmpeg(args) {
  console.log("ffmpeg", args.join(" "));
  execFileSync("ffmpeg", args, { stdio: "inherit" });
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

function detectIntroCutTime(inputPath) {
  const args = [
    "-hide_banner",
    "-t", String(INTRO_SEARCH_SECONDS),
    "-i", inputPath,
    "-af", `silencedetect=noise=${INTRO_SILENCE_DB}:d=${INTRO_SILENCE_MIN}`,
    "-f", "null",
    "-"
  ];

  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8"
  });

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

  console.log("silencedetect output:", output);

  const starts = [...output.matchAll(/silence_start:\s*([0-9.]+)/g)].map(m => Number(m[1]));
  const ends = [...output.matchAll(/silence_end:\s*([0-9.]+)/g)].map(m => Number(m[1]));

  if (!starts.length || !ends.length) {
    console.log("No intro silence detected. No trim.");
    return 0;
  }

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    const silenceStart = starts[i];
    const silenceEnd = ends[i];

    // Нам нужна пауза после служебного intro, а не микропауза в самом начале
    if (
      silenceStart >= 1.0 &&
      silenceEnd <= INTRO_SEARCH_SECONDS &&
      silenceEnd > silenceStart
    ) {
      const cutTime = silenceEnd + CUT_AFTER_SILENCE_PAD;
      console.log(`Intro cut detected: start=${silenceStart}, end=${silenceEnd}, cut=${cutTime}`);
      return cutTime;
    }
  }

  console.log("No suitable intro silence found. No trim.");
  return 0;
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

    for (let i = 0; i < files.length; i++) {
      const input = files[i].path;

      const wav = path.join(
        workDir,
        `part_${String(i + 1).padStart(4, "0")}.wav`
      );

      const cutTime = detectIntroCutTime(input);

      const inputArgs = cutTime > 0
        ? ["-ss", String(cutTime), "-i", input]
        : ["-i", input];

      runFfmpeg([
        "-y",
        ...inputArgs,
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

    const gapWav = path.join(workDir, "gap.wav");

    runFfmpeg([
      "-y",
      "-f", "lavfi",
      "-i", `anullsrc=r=${SAMPLE_RATE}:cl=mono:d=${GAP_SECONDS}`,
      "-ar", String(SAMPLE_RATE),
      "-ac", String(CHANNELS),
      gapWav
    ]);

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
