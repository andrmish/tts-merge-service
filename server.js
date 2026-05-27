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

// Так как после intro-обрезки мы оставляем часть служебной паузы,
// внешнюю паузу между фрагментами делаем короче.
const GAP_SECONDS = 0.22;

// Мягкий fade на краях, чтобы не было щелчков.
const FADE_SECONDS = 0.018;

// Ожидаемая структура каждого файла:
// [служебная фраза 5–7 сек] + [длинная пауза] + [основной текст]

// Ищем длинную паузу только в начале файла.
const INTRO_SEARCH_SECONDS = 13.0;

// Пауза должна начинаться после служебной фразы.
// Так мы не трогаем ранние микропаузы и не режем основной текст.
const INTRO_SILENCE_START_MIN = 5.0;
const INTRO_SILENCE_START_MAX = 9.5;

// Минимальная длительность служебной паузы.
const INTRO_SILENCE_MIN = 0.80;

// Порог тишины.
// Если пауза не находится, можно поднять до "-40dB".
// Если находит слишком много ложных пауз, можно опустить до "-48dB".
const INTRO_SILENCE_DB = "-44dB";

// Сколько тишины оставить перед основным текстом.
// Это главный параметр защиты от обрезания первого слова.
const KEEP_SILENCE_BEFORE_MAIN = 0.45;

// Чтобы не оставлять слишком длинную паузу,
// мы можем войти внутрь найденной паузы минимум на 0.10 сек.
const CUT_MIN_AFTER_SILENCE_START = 0.10;

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

  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

  console.log("silencedetect output:", output);

  const silenceEvents = [];
  const lines = output.split("\n");

  let currentStart = null;

  for (const line of lines) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);

    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }

    const endMatch = line.match(
      /silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/
    );

    if (endMatch && currentStart !== null) {
      silenceEvents.push({
        start: currentStart,
        end: Number(endMatch[1]),
        duration: Number(endMatch[2])
      });

      currentStart = null;
    }
  }

  console.log("Parsed silence events:", silenceEvents);

  const candidates = silenceEvents.filter(ev =>
    ev.start >= INTRO_SILENCE_START_MIN &&
    ev.start <= INTRO_SILENCE_START_MAX &&
    ev.duration >= INTRO_SILENCE_MIN &&
    ev.end <= INTRO_SEARCH_SECONDS
  );

  if (!candidates.length) {
    console.log("No safe intro pause found. No trim to avoid cutting real text.");
    return 0;
  }

  // Берём самую длинную паузу в нужном окне.
  // Это должна быть служебная пауза после intro.
  candidates.sort((a, b) => b.duration - a.duration);
  const introPause = candidates[0];

  // Безопасная обрезка:
  // 1. Удаляем служебную фразу.
  // 2. Режем внутри тишины.
  // 3. Оставляем часть тишины перед основным текстом.
  //
  // Например:
  // pause start = 6.8
  // pause end   = 8.0
  // keep        = 0.45
  // cut         = 7.55
  //
  // Основной текст начинается после 8.0,
  // значит первые слова не съедаются.
  const preferredCut = introPause.end - KEEP_SILENCE_BEFORE_MAIN;
  const earliestSafeCut = introPause.start + CUT_MIN_AFTER_SILENCE_START;

  const cutTime = Math.max(
    0,
    Math.max(earliestSafeCut, preferredCut)
  );

  // Дополнительная защита:
  // никогда не режем после конца найденной паузы.
  const safeCutTime = Math.min(cutTime, introPause.end - 0.05);

  console.log(
    `Safe intro cut: start=${introPause.start}, end=${introPause.end}, duration=${introPause.duration}, cut=${safeCutTime}`
  );

  return safeCutTime;
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

      const inputArgs =
        cutTime > 0
          ? ["-ss", String(cutTime), "-i", input]
          : ["-i", input];

      runFfmpeg([
        "-y",
        ...inputArgs,
        "-ar", String(SAMPLE_RATE),
        "-ac", String(CHANNELS),
        "-af",
        [
          // ВАЖНО:
          // Не используем silenceremove.
          // Он может съедать первые тихие слова основного текста.
          "loudnorm=I=-20:TP=-3:LRA=8",
          "acompressor=threshold=-22dB:ratio=1.15:attack=35:release=220",
          "alimiter=limit=0.92",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse"
        ].join(","),
        wav
      ]);

      processedWavs.push(wav);
    }

    // Создаём короткую нейтральную паузу между уже очищенными фрагментами.
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
      [
        "acompressor=threshold=-20dB:ratio=1.12:attack=35:release=240",
        "loudnorm=I=-16:TP=-1.5:LRA=9",
        "alimiter=limit=0.95"
      ].join(","),
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
