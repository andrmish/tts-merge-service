import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import {mergeAudio,MERGE_VERSION} from "./merge-audio.mjs";

// Requires Node 18+ for global fetch().
//
// ASYNC model: POST /merge immediately returns 202.
// The merge runs in the background and sends the finished MP3
// to result_url when complete.

const app = express();
app.use(express.json({ limit: "10mb" }));

// Пауза между очищенными фрагментами
const GAP_SECONDS = 0.3;

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
    if (fileList.some(file => !file || !file.url)) throw new Error("Invalid source file; refusing to silently omit a part");
    const names=fileList.map(file => file.name).filter(Boolean);
    if (new Set(names).size !== names.length) throw new Error("Duplicate source filenames");
    fileList = fileList
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

    const cutTimes = localInputs.map(detectIntroCutTime);
    const merged = mergeAudio(localInputs, {workDir, cutTimes, gapSeconds:GAP_SECONDS});
    const finalMp3 = merged.mp3;
    console.log(JSON.stringify({event:"audio_qa",chapter_id:chapterId,...merged.qa,
      expected_count_verified:false,
      source_names:fileList.map(file => String(file.name || ""))}));

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
    ok: true,
    merge_version: MERGE_VERSION,
    audio_processing: "preserve-dynamics",
    output_format: "mp3",
    assembly_qa: true
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
    "TTS merge service running (preserve-dynamics, PCM integrity QA, MP3 callback)"
  );
});

