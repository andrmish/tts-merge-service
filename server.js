import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawnSync } from "child_process";

// Requires Node 18+ for global fetch(). Railway's default Node is fine;
// if you pin an older version, add `import fetch from "node-fetch"`.

const app = express();

// The request body is now just a small JSON list of URLs, not the audio.
app.use(express.json({ limit: "10mb" }));

const SAMPLE_RATE = 44100;
const CHANNELS = 1;

// Пауза между очищенными фрагментами
const GAP_SECONDS = 0.30;

// Мягкие края
const FADE_SECONDS = 0.018;

// Ожидаемая структура:
// [Intonation bug removal test] + [первая длинная пауза в первые 5 сек] + [основной текст]

const INTRO_SEARCH_SECONDS = 7.0;
const INTRO_PAUSE_START_MAX = 5.0;
const INTRO_SILENCE_MIN = 0.45;
const INTRO_SILENCE_DB = "-38dB";
const KEEP_SILENCE_BEFORE_MAIN = 0.22;

// How many parts to download in parallel (keeps total fetch time low
// for long chapters without holding everything in memory — each part
// is streamed to disk).
const DOWNLOAD_CONCURRENCY = 8;

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

  const firstIntroPause = silenceEvents.find(ev =>
    ev.start > 0.20 &&
    ev.start <= INTRO_PAUSE_START_MAX &&
    ev.duration >= INTRO_SILENCE_MIN
  );

  if (!firstIntroPause) {
    console.log("No intro pause found in first 5 seconds. No trim.");
    return 0;
  }

  const cutTime = Math.max(0, firstIntroPause.end - KEEP_SILENCE_BEFORE_MAIN);

  console.log(
    `Intro cut by FIRST pause in first 5 sec: start=${firstIntroPause.start}, end=${firstIntroPause.end}, duration=${firstIntroPause.duration}, cut=${cutTime}`
  );

  return cutTime;
}

// Download one part URL to disk.
async function downloadToFile(url, destPath) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed (${resp.status}) for ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf.length;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/merge", async (req, res) => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-merge-"));

  try {
    const chapterId = req.body?.chapter_id;
    let fileList = Array.isArray(req.body?.files) ? req.body.files : [];

    if (!fileList.length) {
      return res.status(400).json({ error: "No files provided" });
    }

    // Sort by name (numeric) so playback order is correct, then download
    // in that order — local filenames carry the index so on-disk order
    // matches regardless.
    fileList = fileList
      .filter(f => f && f.url)
      .sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || ""), undefined, {
          numeric: true,
          sensitivity: "base"
        })
      );

    // Download all parts to disk (bounded concurrency).
    const localInputs = new Array(fileList.length);
    let totalBytes = 0;

    for (let start = 0; start < fileList.length; start += DOWNLOAD_CONCURRENCY) {
      const slice = fileList.slice(start, start + DOWNLOAD_CONCURRENCY);

      await Promise.all(
        slice.map(async (f, j) => {
          const idx = start + j;
          const dest = path.join(
            workDir,
            `in_${String(idx + 1).padStart(4, "0")}.audio`
          );
          const size = await downloadToFile(f.url, dest);
          totalBytes += size;
          localInputs[idx] = dest;
        })
      );
    }

    console.log(
      `Downloaded chapter=${chapterId} parts=${localInputs.length} totalBytes=${totalBytes}`
    );

    const processedWavs = [];

    for (let i = 0; i < localInputs.length; i++) {
      const input = localInputs[i];

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
          // НЕ используем silenceremove, чтобы не съедать начало основного текста
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
    res.status(500).json({ error: err.message });
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("TTS merge service running (pull mode)");
});
