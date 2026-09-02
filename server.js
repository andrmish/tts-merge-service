import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync, spawnSync } from "child_process";

// Requires Node 18+ for global fetch().
//
// ASYNC model: POST /merge immediately returns 202.
// The merge runs in the background and sends the finished MP3
// to result_url when complete.

const app = express();
app.use(express.json({ limit: "10mb" }));

const SAMPLE_RATE = 44100;
const CHANNELS = 1;

// Пауза между очищенными фрагментами
const GAP_SECONDS = 0.3;

// Мягкие края
const FADE_SECONDS = 0.018;

// Поиск служебной фразы и первой паузы
const INTRO_SEARCH_SECONDS = 7.0;
const INTRO_PAUSE_START_MAX = 5.0;
const INTRO_SILENCE_MIN = 0.45;
const INTRO_SILENCE_DB = "-38dB";
const KEEP_SILENCE_BEFORE_MAIN = 0.22;

// Количество параллельных загрузок
const DOWNLOAD_CONCURRENCY = 8;

// Количество попыток отправки готового MP3
const RESULT_UPLOAD_ATTEMPTS = 5;

// Количество попыток сообщить Worker об ошибке
const ERROR_REPORT_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runFfmpeg(args) {
  console.log("ffmpeg", args.join(" "));

  execFileSync("ffmpeg", args, {
    stdio: "inherit"
  });
}

function escapeConcatPath(filePath) {
  return filePath.replace(/'/g, "'\\''");
}

function detectIntroCutTime(inputPath) {
  const args = [
    "-hide_banner",
    "-t",
    String(INTRO_SEARCH_SECONDS),
    "-i",
    inputPath,
    "-af",
    `silencedetect=noise=${INTRO_SILENCE_DB}:d=${INTRO_SILENCE_MIN}`,
    "-f",
    "null",
    "-"
  ];

  const result = spawnSync("ffmpeg", args, {
    encoding: "utf8"
  });

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;

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

  const firstIntroPause = silenceEvents.find(
    event =>
      event.start > 0.2 &&
      event.start <= INTRO_PAUSE_START_MAX &&
      event.duration >= INTRO_SILENCE_MIN
  );

  if (!firstIntroPause) {
    return 0;
  }

  const cutTime = Math.max(
    0,
    firstIntroPause.end - KEEP_SILENCE_BEFORE_MAIN
  );

  console.log(
    `chapter intro cut: start=${firstIntroPause.start} ` +
      `end=${firstIntroPause.end} cut=${cutTime}`
  );

  return cutTime;
}

// Загрузка одной исходной части с повторными попытками
async function downloadToFile(url, destPath, attempts = 8) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());

        fs.writeFileSync(destPath, buffer);

        return buffer.length;
      }

      lastError = new Error(
        `Download failed (${response.status}) for ${url}`
      );
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      const delay = Math.min(
        15000,
        1000 * Math.pow(2, attempt - 1)
      );

      console.warn(
        `Download attempt ${attempt}/${attempts} failed. ` +
          `Retrying in ${delay}ms: ${lastError?.message || lastError}`
      );

      await sleep(delay);
    }
  }

  throw lastError || new Error(`Download failed for ${url}`);
}

// Отправка готового MP3 обратно в Cloudflare Worker.
// Сетевые ошибки, 408, 429 и 5xx повторяются автоматически.
async function uploadResultWithRetry(
  resultUrl,
  outputBuffer,
  chapterId,
  attempts = RESULT_UPLOAD_ATTEMPTS
) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(
        `chapter=${chapterId} result upload ` +
          `attempt=${attempt}/${attempts} bytes=${outputBuffer.length}`
      );

      const response = await fetch(resultUrl, {
        method: "POST",
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(outputBuffer.length)
        },
        body: outputBuffer
      });

      if (response.ok) {
        console.log(
          `chapter=${chapterId} result uploaded ` +
            `bytes=${outputBuffer.length} attempt=${attempt}`
        );

        return;
      }

      const responseText = await response.text().catch(() => "");

      lastError = new Error(
        `result upload failed (${response.status}) ` +
          responseText.slice(0, 200)
      );

      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;

      if (!retryable) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      const delay = Math.min(
        30000,
        1000 * Math.pow(2, attempt - 1)
      );

      console.warn(
        `chapter=${chapterId} result upload ` +
          `attempt=${attempt}/${attempts} failed. ` +
          `Retrying in ${delay}ms: ${lastError?.message || lastError}`
      );

      await sleep(delay);
    }
  }

  throw (
    lastError ||
    new Error(
      `chapter=${chapterId} result upload failed after ${attempts} attempts`
    )
  );
}

// Сообщение Worker о настоящей ошибке сборки
async function reportMergeError(resultUrl, error, chapterId) {
  const errorMessage = String(
    error?.message || error || "Unknown merge error"
  ).slice(0, 400);

  let lastError;

  for (
    let attempt = 1;
    attempt <= ERROR_REPORT_ATTEMPTS;
    attempt++
  ) {
    try {
      const response = await fetch(resultUrl, {
        method: "POST",
        headers: {
          "X-Merge-Status": "error",
          "X-Merge-Error": errorMessage
        }
      });

      if (response.ok) {
        console.log(
          `chapter=${chapterId} merge error reported ` +
            `attempt=${attempt}`
        );

        return;
      }

      lastError = new Error(
        `error report failed (${response.status})`
      );
    } catch (reportError) {
      lastError = reportError;
    }

    if (attempt < ERROR_REPORT_ATTEMPTS) {
      const delay = 1000 * Math.pow(2, attempt - 1);

      console.warn(
        `chapter=${chapterId} error report attempt=${attempt} failed. ` +
          `Retrying in ${delay}ms: ${lastError?.message || lastError}`
      );

      await sleep(delay);
    }
  }

  console.error(
    `chapter=${chapterId} failed to report merge error:`,
    lastError
  );
}

async function processChapter(chapterId, fileList, resultUrl) {
  const workDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "tts-merge-")
  );

  try {
    fileList = fileList
      .filter(file => file && file.url)
      .sort((a, b) =>
        String(a.name || "").localeCompare(
          String(b.name || ""),
          undefined,
          {
            numeric: true,
            sensitivity: "base"
          }
        )
      );

    if (!fileList.length) {
      throw new Error("No valid audio files supplied");
    }

    const localInputs = new Array(fileList.length);
    let totalBytes = 0;

    // Загружаем части с ограниченной параллельностью
    for (
      let start = 0;
      start < fileList.length;
      start += DOWNLOAD_CONCURRENCY
    ) {
      const slice = fileList.slice(
        start,
        start + DOWNLOAD_CONCURRENCY
      );

      await Promise.all(
        slice.map(async (file, sliceIndex) => {
          const index = start + sliceIndex;

          const destination = path.join(
            workDir,
            `in_${String(index + 1).padStart(4, "0")}.audio`
          );

          const size = await downloadToFile(
            file.url,
            destination
          );

          totalBytes += size;
          localInputs[index] = destination;
        })
      );
    }

    console.log(
      `chapter=${chapterId} downloaded ` +
        `parts=${localInputs.length} bytes=${totalBytes}`
    );

    const processedWavs = [];

    // Обрабатываем каждую часть
    for (let index = 0; index < localInputs.length; index++) {
      const input = localInputs[index];

      const outputWav = path.join(
        workDir,
        `part_${String(index + 1).padStart(4, "0")}.wav`
      );

      const cutTime = detectIntroCutTime(input);

      const inputArgs =
        cutTime > 0
          ? ["-ss", String(cutTime), "-i", input]
          : ["-i", input];

      runFfmpeg([
        "-y",
        ...inputArgs,
        "-ar",
        String(SAMPLE_RATE),
        "-ac",
        String(CHANNELS),
        "-af",
        [
          "loudnorm=I=-20:TP=-3:LRA=8",
          "acompressor=threshold=-22dB:ratio=1.15:attack=35:release=220",
          "alimiter=limit=0.92",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse",
          `afade=t=in:st=0:d=${FADE_SECONDS}`,
          "areverse"
        ].join(","),
        outputWav
      ]);

      processedWavs.push(outputWav);
    }

    // Создаём паузу между частями
    const gapWav = path.join(workDir, "gap.wav");

    runFfmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${SAMPLE_RATE}:cl=mono:d=${GAP_SECONDS}`,
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      String(CHANNELS),
      gapWav
    ]);

    // Создаём список для concat
    const concatListPath = path.join(
      workDir,
      "concat.txt"
    );

    const concatLines = [];

    for (
      let index = 0;
      index < processedWavs.length;
      index++
    ) {
      concatLines.push(
        `file '${escapeConcatPath(processedWavs[index])}'`
      );

      if (index < processedWavs.length - 1) {
        concatLines.push(
          `file '${escapeConcatPath(gapWav)}'`
        );
      }
    }

    fs.writeFileSync(
      concatListPath,
      concatLines.join("\n")
    );

    // Склеиваем WAV
    const mergedWav = path.join(workDir, "merged.wav");

    runFfmpeg([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      mergedWav
    ]);

    // Создаём финальный MP3
    const finalMp3 = path.join(workDir, "final.mp3");

    runFfmpeg([
      "-y",
      "-i",
      mergedWav,
      "-af",
      [
        "acompressor=threshold=-20dB:ratio=1.12:attack=35:release=240",
        "loudnorm=I=-16:TP=-1.5:LRA=9",
        "alimiter=limit=0.95"
      ].join(","),
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "192k",
      finalMp3
    ]);

    if (!fs.existsSync(finalMp3)) {
      throw new Error("Final MP3 was not created");
    }

    const outputBuffer = fs.readFileSync(finalMp3);

    if (!outputBuffer.length) {
      throw new Error("Final MP3 is empty");
    }

    // Готовый MP3 не удаляется до завершения всех попыток отправки
    await uploadResultWithRetry(
      resultUrl,
      outputBuffer,
      chapterId
    );
  } finally {
    try {
      fs.rmSync(workDir, {
        recursive: true,
        force: true
      });
    } catch (cleanupError) {
      console.error(
        `chapter=${chapterId} cleanup failed:`,
        cleanupError
      );
    }
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true
  });
});

// Не допускаем одновременную повторную обработку одной главы
const inFlight = new Set();

app.post("/merge", (req, res) => {
  const chapterId = String(
    req.body?.chapter_id ?? ""
  );

  const fileList = Array.isArray(req.body?.files)
    ? req.body.files
    : [];

  const resultUrl = req.body?.result_url;

  if (!chapterId || !fileList.length || !resultUrl) {
    return res.status(400).json({
      error: "Missing chapter_id, files, or result_url"
    });
  }

  if (inFlight.has(chapterId)) {
    return res.status(202).json({
      status: "already-processing",
      chapter_id: chapterId
    });
  }

  inFlight.add(chapterId);

  // Сразу отвечаем Make/Worker, сборка продолжается в фоне
  res.status(202).json({
    status: "processing",
    chapter_id: chapterId,
    parts: fileList.length
  });

  processChapter(chapterId, fileList, resultUrl)
    .catch(async error => {
      console.error(
        `chapter=${chapterId} MERGE ERROR (bg):`,
        error
      );

      await reportMergeError(
        resultUrl,
        error,
        chapterId
      );
    })
    .finally(() => {
      inFlight.delete(chapterId);
    });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(
    "TTS merge service running (async mode with result upload retry)"
  );
});
