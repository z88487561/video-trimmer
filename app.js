import { FFmpeg } from "./vendor/ffmpeg/classes.js";

const CORE_VERSION = "0.12.10";
const CORE_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_CACHE = `video-trimmer-ffmpeg-core-${CORE_VERSION}`;
const DEFAULT_MEMFS_THRESHOLD_MB = 256;

const elements = {
    file: document.getElementById("videoFile"),
    preview: document.getElementById("preview"),
    fileName: document.getElementById("fileName"),
    memoryWarning: document.getElementById("memoryWarning"),
    duration: document.getElementById("durationLabel"),
    start: document.getElementById("startTime"),
    end: document.getElementById("endTime"),
    startRange: document.getElementById("startRange"),
    endRange: document.getElementById("endRange"),
    startRangeLabel: document.getElementById("startRangeLabel"),
    endRangeLabel: document.getElementById("endRangeLabel"),
    playbackTime: document.getElementById("playbackTime"),
    timelineTrack: document.getElementById("timelineTrack"),
    markStart: document.getElementById("markStart"),
    markEnd: document.getElementById("markEnd"),
    videoStage: document.getElementById("videoStage"),
    cropFrame: document.getElementById("cropFrame"),
    removeAudio: document.getElementById("removeAudio"),
    rotation: document.getElementById("rotation"),
    aspectRatio: document.getElementById("aspectRatio"),
    customRatio: document.getElementById("customRatio"),
    ratioWidth: document.getElementById("ratioWidth"),
    ratioHeight: document.getElementById("ratioHeight"),
    cropHint: document.getElementById("cropHint"),
    compressVideo: document.getElementById("compressVideo"),
    compressionOptions: document.getElementById("compressionOptions"),
    compressionHint: document.getElementById("compressionHint"),
    resolution: document.getElementById("resolution"),
    quality: document.getElementById("quality"),
    trim: document.getElementById("trimButton"),
    processingMode: document.getElementById("processingMode"),
    readMode: document.getElementById("readMode"),
    memfsThreshold: document.getElementById("memfsThreshold"),
    status: document.getElementById("status"),
    download: document.getElementById("downloadLink"),
    install: document.getElementById("installButton"),
    pwaStatus: document.getElementById("pwaStatus")
};

let selectedFile = null;
let previewUrl = null;
let outputUrl = null;
let ffmpeg = null;
let isBusy = false;
let installPrompt = null;
let recentFfmpegLogs = [];
let cropCenter = { x: 0.5, y: 0.5 };
let cropDrag = null;
let activeProcessingMode = "copy";

function setStatus(message, state = "") {
    elements.status.textContent = message;
    elements.status.dataset.state = state;
}

function setBusy(busy) {
    isBusy = busy;
    elements.trim.disabled = busy || !selectedFile;
    elements.file.disabled = busy;
    elements.start.disabled = busy;
    elements.end.disabled = busy;
    elements.startRange.disabled = busy || !selectedFile || !Number.isFinite(elements.preview.duration);
    elements.endRange.disabled = busy || !selectedFile || !Number.isFinite(elements.preview.duration);
    elements.markStart.disabled = busy || !selectedFile;
    elements.markEnd.disabled = busy || !selectedFile;
    for (const control of [
        elements.removeAudio, elements.rotation, elements.aspectRatio,
        elements.ratioWidth, elements.ratioHeight, elements.compressVideo,
        elements.resolution, elements.quality, elements.readMode,
        elements.memfsThreshold
    ]) control.disabled = busy;
}

function clearDownload() {
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
    elements.download.removeAttribute("href");
    elements.download.hidden = true;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const remainder = seconds - hours * 3600 - minutes * 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function formatFileSize(bytes) {
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(bytes / 1024).toFixed(1)} KB`;
}

function formatElapsed(milliseconds) {
    return `${(milliseconds / 1000).toFixed(2)} 秒`;
}

function getMemfsThresholdBytes() {
    const thresholdMb = Number(elements.memfsThreshold.value);
    if (!Number.isInteger(thresholdMb) || thresholdMb < 64 || thresholdMb > 2048) {
        throw new Error("MEMFS 檔案大小門檻須介於 64 至 2048 MB。");
    }
    return thresholdMb * 1024 * 1024;
}

function getEffectiveMemfsLimit(thresholdBytes) {
    const deviceMemoryGb = Number(navigator.deviceMemory);
    if (!Number.isFinite(deviceMemoryGb) || deviceMemoryGb <= 0) return thresholdBytes;
    return Math.min(thresholdBytes, deviceMemoryGb * 1024 * 1024 * 1024 * 0.08);
}

function getReadMode(file, thresholdBytes = getMemfsThresholdBytes()) {
    const effectiveLimit = getEffectiveMemfsLimit(thresholdBytes);
    if (elements.readMode.value !== "auto") return elements.readMode.value;
    return file.size <= effectiveLimit ? "memfs" : "workerfs";
}

function updateMemoryWarning(file = selectedFile) {
    if (!file) {
        elements.memoryWarning.hidden = true;
        elements.memoryWarning.textContent = "";
        return;
    }
    const thresholdBytes = getMemfsThresholdBytes();
    const effectiveLimit = getEffectiveMemfsLimit(thresholdBytes);
    const readMode = getReadMode(file, thresholdBytes);
    const isLarge = file.size > effectiveLimit;
    elements.memoryWarning.hidden = !isLarge;
    elements.memoryWarning.textContent = isLarge
        ? `大型影片：目前讀取方式為 ${readMode.toUpperCase()}，來源大小 ${formatFileSize(file.size)}，自動模式的 MEMFS 上限約 ${Math.floor(effectiveLimit / 1024 / 1024)} MB。MEMFS 會複製整個來源檔，可能造成記憶體不足；輸出本身仍會載入記憶體，建議改用自動／WORKERFS、縮短裁切區間或降低解析度。`
        : "";
}

function safeExtension(name) {
    const match = name.match(/\.([a-z0-9]{1,8})$/i);
    if (!match) throw new Error("無法判斷影片副檔名，請使用常見影片格式。");
    return `.${match[1].toLowerCase()}`;
}

function markTime(input) {
    if (!Number.isFinite(elements.preview.currentTime)) return;
    input.value = elements.preview.currentTime.toFixed(2);
    updateRangeControls(input === elements.start ? "start" : "end");
}

function updateRangeControls(changed = "") {
    const duration = elements.preview.duration;
    if (!Number.isFinite(duration)) return;
    const start = Number(elements.start.value);
    const end = Number(elements.end.value);
    elements.startRange.max = String(duration);
    elements.endRange.max = String(duration);
    if (Number.isFinite(start)) {
        elements.startRange.value = String(Math.max(0, Math.min(duration, start)));
        elements.startRangeLabel.textContent = formatTime(start);
    }
    if (Number.isFinite(end)) {
        elements.endRange.value = String(Math.max(0, Math.min(duration, end)));
        elements.endRangeLabel.textContent = formatTime(end);
    }
    const startPosition = Math.max(0, Math.min(100, start / duration * 100));
    const endPosition = Math.max(startPosition, Math.min(100, end / duration * 100));
    elements.timelineTrack.style.setProperty("--start-position", `${startPosition}%`);
    elements.timelineTrack.style.setProperty("--end-position", `${endPosition}%`);
    elements.startRange.setAttribute("aria-valuetext", `開始 ${formatTime(Number(elements.startRange.value))}`);
    elements.endRange.setAttribute("aria-valuetext", `結束 ${formatTime(Number(elements.endRange.value))}`);
    if (changed === "start") elements.preview.currentTime = Math.min(Number(elements.start.value) || 0, duration);
    if (changed === "end") elements.preview.currentTime = Math.min(Number(elements.end.value) || 0, duration);
    updatePlaybackPosition();
}

function updatePlaybackPosition() {
    const duration = elements.preview.duration;
    const currentTime = Number.isFinite(elements.preview.currentTime) ? elements.preview.currentTime : 0;
    elements.playbackTime.textContent = formatTime(currentTime);
    const position = Number.isFinite(duration) && duration > 0
        ? Math.max(0, Math.min(100, currentTime / duration * 100))
        : 0;
    elements.timelineTrack.style.setProperty("--play-position", `${position}%`);
}

function readTrimRange() {
    const start = Number(elements.start.value);
    const end = Number(elements.end.value);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error("請輸入有效的開始及結束時間，且結束時間必須大於開始時間。");
    }
    if (Number.isFinite(elements.preview.duration) && end > elements.preview.duration) {
        throw new Error("結束時間不可超過影片長度。");
    }
    return { start, end };
}

function getSelectedAspectRatio() {
    const value = elements.aspectRatio.value;
    if (value === "original") return null;
    if (value === "custom") {
        const width = Number(elements.ratioWidth.value);
        const height = Number(elements.ratioHeight.value);
        if (!Number.isInteger(width) || !Number.isInteger(height)
            || width < 1 || height < 1 || width > 100 || height > 100) {
            throw new Error("請輸入有效的自訂畫面比例寬度與高度。");
        }
        return width / height;
    }
    const [width, height] = value.split(":").map(Number);
    return width / height;
}

function getCompressionTarget(resolution, width, height) {
    if (!width || !height) return null;
    const sourceShortSide = Math.min(width, height);
    let target;
    if (resolution === "auto") {
        target = sourceShortSide > 720 ? 720 : sourceShortSide > 480 ? 480 : null;
    } else {
        target = Number(resolution);
    }
    return target && sourceShortSide > target ? target : null;
}

function updateCompressionControls() {
    const width = elements.preview.videoWidth;
    const height = elements.preview.videoHeight;
    const sourceShortSide = width && height ? Math.min(width, height) : null;
    const option720 = elements.resolution.querySelector('option[value="720"]');
    const option480 = elements.resolution.querySelector('option[value="480"]');
    option720.disabled = sourceShortSide !== null && sourceShortSide <= 720;
    option480.disabled = sourceShortSide !== null && sourceShortSide <= 480;
    if (elements.resolution.selectedOptions[0]?.disabled) elements.resolution.value = "auto";
    if (sourceShortSide === null) {
        elements.compressionHint.textContent = "自動：縮至 720p 或 480p；720p／480p 選項只在來源高於該解析度時可選。";
    } else if (sourceShortSide <= 480) {
        elements.compressionHint.textContent = "來源低於或等於 480p，壓縮解析度不會縮放影片；若未選其他編輯功能，仍以無損方式裁切。";
    } else if (sourceShortSide <= 720) {
        elements.compressionHint.textContent = "來源低於 720p，只能選 480p 進行縮小；自動模式也會縮至 480p。";
    } else {
        elements.compressionHint.textContent = "自動模式會將高於 720p 的來源縮至 720p；手動目標只允許縮小。";
    }
    updateActionLabel();
}

function getVideoContentRect() {
    const width = elements.preview.videoWidth;
    const height = elements.preview.videoHeight;
    if (!width || !height) throw new Error("無法讀取影片畫面尺寸，請確認影片可正常預覽。");
    const stageWidth = elements.videoStage.clientWidth;
    const stageHeight = elements.videoStage.clientHeight;
    const scale = Math.min(stageWidth / width, stageHeight / height);
    const contentWidth = width * scale;
    const contentHeight = height * scale;
    return {
        left: (stageWidth - contentWidth) / 2,
        top: (stageHeight - contentHeight) / 2,
        width: contentWidth,
        height: contentHeight
    };
}

function getCropFrameRect(aspectRatio) {
    const content = getVideoContentRect();
    const width = Math.min(content.width, content.height * aspectRatio);
    const height = width / aspectRatio;
    const centerX = Math.max(width / 2, Math.min(content.width - width / 2, cropCenter.x * content.width));
    const centerY = Math.max(height / 2, Math.min(content.height - height / 2, cropCenter.y * content.height));
    return {
        content,
        left: content.left + centerX - width / 2,
        top: content.top + centerY - height / 2,
        width,
        height,
        centerX,
        centerY
    };
}

function getSourceCropAspectRatio(outputAspectRatio) {
    return outputAspectRatio && [90, 270].includes(Number(elements.rotation.value))
        ? 1 / outputAspectRatio
        : outputAspectRatio;
}

function updateCropFrame() {
    let outputRatio;
    try {
        outputRatio = getSelectedAspectRatio();
    } catch {
        elements.cropFrame.hidden = true;
        elements.cropHint.hidden = true;
        elements.customRatio.hidden = elements.aspectRatio.value !== "custom";
        return;
    }
    const ratio = getSourceCropAspectRatio(outputRatio);
    const hasVideo = elements.preview.videoWidth > 0 && elements.preview.videoHeight > 0;
    const visible = Boolean(ratio && hasVideo);
    elements.cropFrame.hidden = !visible;
    elements.cropHint.hidden = !visible;
    elements.customRatio.hidden = elements.aspectRatio.value !== "custom";
    if (!visible) return;
    const rect = getCropFrameRect(ratio);
    Object.assign(elements.cropFrame.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`
    });
}

function getCropPixels(aspectRatio) {
    const rect = getCropFrameRect(aspectRatio);
    const width = elements.preview.videoWidth;
    const height = elements.preview.videoHeight;
    const even = value => Math.max(2, Math.floor(value / 2) * 2);
    const cropWidth = Math.min(width - (width % 2), even(rect.width / rect.content.width * width));
    const cropHeight = Math.min(height - (height % 2), even(rect.height / rect.content.height * height));
    const x = Math.min(width - cropWidth, even((rect.centerX - rect.width / 2) / rect.content.width * width));
    const y = Math.min(height - cropHeight, even((rect.centerY - rect.height / 2) / rect.content.height * height));
    return { x, y, width: cropWidth, height: cropHeight };
}

function getEditOptions() {
    const aspectRatio = getSelectedAspectRatio();
    const rotation = Number(elements.rotation.value);
    const removeAudio = elements.removeAudio.checked;
    const compress = elements.compressVideo.checked;
    if (compress && (!elements.preview.videoWidth || !elements.preview.videoHeight)) {
        throw new Error("調整輸出解析度前，請先確認瀏覽器能讀取影片畫面尺寸。");
    }
    const compressionTarget = compress
        ? getCompressionTarget(elements.resolution.value, elements.preview.videoWidth, elements.preview.videoHeight)
        : null;
    return {
        aspectRatio,
        rotation,
        removeAudio,
        compress,
        quality: elements.quality.value,
        resolution: elements.resolution.value,
        compressionTarget,
        encodeVideo: rotation !== 0 || aspectRatio !== null || compressionTarget !== null
    };
}

function updateActionLabel() {
    try {
        const options = getEditOptions();
        elements.trim.textContent = options.encodeVideo || options.removeAudio ? "處理並下載" : "裁切並下載";
        if (options.encodeVideo) {
            elements.processingMode.textContent = "目前模式：重新編碼並輸出 MP4。";
            elements.processingMode.dataset.mode = "encode";
        } else if (options.removeAudio) {
            elements.processingMode.textContent = "目前模式：複製影片封包並移除音訊；影片不重新編碼。";
            elements.processingMode.dataset.mode = "copy";
        } else {
            elements.processingMode.textContent = "目前模式：封包複製，不重新編碼影片。";
            elements.processingMode.dataset.mode = "copy";
        }
    } catch {
        elements.trim.textContent = "處理並下載";
        elements.processingMode.textContent = "目前模式：請確認影片資訊與輸出選項。";
        elements.processingMode.dataset.mode = "error";
    }
}

async function fetchCoreAsset(url, contentType) {
    let response;
    if ("caches" in window) {
        const cache = await caches.open(CORE_CACHE);
        response = await cache.match(url);
        if (!response) {
            setStatus("正在下載影片處理引擎（首次約 32 MB）…", "busy");
            response = await fetch(url);
            if (!response.ok || response.type === "opaque") {
                throw new Error(`無法取得處理引擎：HTTP ${response.status}`);
            }
            await cache.put(url, response.clone());
        }
    } else {
        setStatus("正在下載影片處理引擎（首次約 32 MB）…", "busy");
        response = await fetch(url);
        if (!response.ok || response.type === "opaque") {
            throw new Error(`無法取得處理引擎：HTTP ${response.status}`);
        }
    }
    return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: contentType }));
}

async function ensureEngine() {
    if (ffmpeg?.loaded) return ffmpeg;
    if (!window.isSecureContext || !("Worker" in window)) {
        throw new Error("影片處理引擎需要安全來源，請以 localhost 或 HTTPS 開啟此 PWA。");
    }
    const coreUrl = `${CORE_BASE}/ffmpeg-core.js`;
    const wasmUrl = `${CORE_BASE}/ffmpeg-core.wasm`;
    const [coreBlobUrl, wasmBlobUrl] = await Promise.all([
        fetchCoreAsset(coreUrl, "text/javascript"),
        fetchCoreAsset(wasmUrl, "application/wasm")
    ]);
    try {
        ffmpeg = new FFmpeg();
        ffmpeg.on("log", ({ message }) => {
            if (message) {
                recentFfmpegLogs.push(message);
                if (recentFfmpegLogs.length > 6) recentFfmpegLogs.shift();
                const operation = activeProcessingMode === "encode"
                    ? "正在重新編碼影片"
                    : "正在複製影片封包（不重新編碼）";
                elements.status.textContent = `${operation}：${message.slice(0, 180)}`;
            }
        });
        await ffmpeg.load({ coreURL: coreBlobUrl, wasmURL: wasmBlobUrl });
        return ffmpeg;
    } catch (error) {
        if (ffmpeg) {
            try {
                await ffmpeg.terminate();
            } catch (cleanupError) {
                console.error("無法清除未載入的 FFmpeg Worker：", cleanupError);
            }
        }
        ffmpeg = null;
        throw new Error(`處理引擎載入失敗：${error.message}`);
    } finally {
        URL.revokeObjectURL(coreBlobUrl);
        URL.revokeObjectURL(wasmBlobUrl);
    }
}

async function trimVideo() {
    if (isBusy || !selectedFile) return;
    clearDownload();
    const sourceFile = selectedFile;
    let saveHandlePromise = null;
    let range;
    let extension;
    let outputExtension;
    let options;
    let readMode;
    let effectiveMemfsLimit;
    const baseName = sourceFile.name.replace(/\.[^.]+$/, "") || "video";
    try {
        range = readTrimRange();
        extension = safeExtension(sourceFile.name);
        options = getEditOptions();
        const thresholdBytes = getMemfsThresholdBytes();
        effectiveMemfsLimit = getEffectiveMemfsLimit(thresholdBytes);
        readMode = getReadMode(sourceFile, thresholdBytes);
        if (readMode === "memfs" && sourceFile.size > effectiveMemfsLimit
            && !window.confirm(
                `此影片大小為 ${formatFileSize(sourceFile.size)}，超過目前 MEMFS 記憶體門檻。`
                + "MEMFS 會複製整個來源檔，可能造成記憶體不足；建議取消並改用自動或 WORKERFS。仍要使用 MEMFS 嗎？"
            )) {
            setStatus("已取消處理；可改用自動或 WORKERFS 讀取大型影片。");
            return;
        }
        outputExtension = options.encodeVideo ? ".mp4" : extension;
        if ("showSaveFilePicker" in window) {
            saveHandlePromise = window.showSaveFilePicker({
                suggestedName: `${baseName}_${options.encodeVideo ? "edited" : "trimmed"}${outputExtension}`
            });
        }
    } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), "error");
        return;
    }

    setBusy(true);
    activeProcessingMode = options.encodeVideo ? "encode" : "copy";
    let mounted = false;
    let inputDirectoryCreated = false;
    let inputFileMayExist = false;
    let outputFileMayExist = false;
    let sourceData = null;
    let result = null;
    let engine;
    const mountPoint = "/local-video";
    const inputPath = `${mountPoint}/source${extension}`;
    const outputPath = "/processed-video";
    const outputFile = `${outputPath}${outputExtension}`;
    const timings = {};
    let totalStartedAt = null;

    try {
        if (saveHandlePromise) setStatus("請選擇裁切影片的儲存位置…", "busy");
        const saveHandle = saveHandlePromise ? await saveHandlePromise : null;
        totalStartedAt = performance.now();
        setStatus("正在準備本機處理引擎…", "busy");
        let phaseStartedAt = performance.now();
        engine = await ensureEngine();
        timings.engine = performance.now() - phaseStartedAt;

        phaseStartedAt = performance.now();
        await engine.createDir(mountPoint);
        inputDirectoryCreated = true;
        if (readMode === "memfs") {
            phaseStartedAt = performance.now();
            sourceData = new Uint8Array(await sourceFile.arrayBuffer());
            timings.sourceRead = performance.now() - phaseStartedAt;
            phaseStartedAt = performance.now();
            inputFileMayExist = true;
            await engine.writeFile(inputPath, sourceData);
            sourceData = null;
            timings.sourceWrite = performance.now() - phaseStartedAt;
        } else {
            await engine.mount("WORKERFS", {
                blobs: [{ name: `source${extension}`, data: sourceFile }]
            }, mountPoint);
            mounted = true;
            timings.sourceMount = performance.now() - phaseStartedAt;
        }

        const duration = range.end - range.start;
        const args = [
            "-y", "-ss", range.start.toFixed(3),
            "-i", inputPath,
            "-t", duration.toFixed(3)
        ];
        if (options.encodeVideo) {
            const filters = [];
            let outputWidth = elements.preview.videoWidth;
            let outputHeight = elements.preview.videoHeight;
            if (options.aspectRatio !== null) {
                const crop = getCropPixels(getSourceCropAspectRatio(options.aspectRatio));
                filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
                outputWidth = crop.width;
                outputHeight = crop.height;
            }
            if (options.rotation === 90) {
                filters.push("transpose=1");
                [outputWidth, outputHeight] = [outputHeight, outputWidth];
            } else if (options.rotation === 180) {
                filters.push("hflip,vflip");
            } else if (options.rotation === 270) {
                filters.push("transpose=2");
                [outputWidth, outputHeight] = [outputHeight, outputWidth];
            }
            if (options.compressionTarget !== null
                && options.compressionTarget < Math.min(outputWidth, outputHeight)) {
                const limit = options.compressionTarget;
                const scale = Math.min(1, limit / Math.min(outputWidth, outputHeight));
                outputWidth = Math.max(2, Math.floor(outputWidth * scale / 2) * 2);
                outputHeight = Math.max(2, Math.floor(outputHeight * scale / 2) * 2);
                filters.push(`scale=${outputWidth}:${outputHeight}`);
            }
            args.push("-map", "0:v:0");
            if (options.removeAudio) {
                args.push("-an");
            } else {
                args.push("-map", "0:a?", "-c:a", "aac", "-b:a", "128k");
            }
            if (filters.length) args.push("-vf", filters.join(","));
            args.push("-c:v", "libx264", "-preset", "veryfast",
                "-crf", options.compress ? options.quality : "23", "-pix_fmt", "yuv420p",
                "-movflags", "+faststart");
        } else {
            args.push("-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero");
            if (options.removeAudio) args.push("-an");
            if ([".mp4", ".mov", ".m4v", ".3gp"].includes(extension)) {
                args.push("-movflags", "+faststart");
            }
        }
        args.push(outputFile);

        setStatus(options.encodeVideo
            ? "正在重新編碼所選片段；請保持頁面開啟…"
            : `正在複製所選片段的影音封包${options.removeAudio ? "並移除音訊" : ""}；影片不會重新編碼，請保持頁面開啟…`, "busy");
        recentFfmpegLogs = [];
        phaseStartedAt = performance.now();
        outputFileMayExist = true;
        const exitCode = await engine.exec(args);
        timings.ffmpeg = performance.now() - phaseStartedAt;
        phaseStartedAt = performance.now();
        if (inputFileMayExist) {
            await engine.deleteFile(inputPath);
            inputFileMayExist = false;
        }
        if (mounted) {
            await engine.unmount(mountPoint);
            mounted = false;
        }
        if (inputDirectoryCreated) {
            await engine.deleteDir(mountPoint);
            inputDirectoryCreated = false;
        }
        timings.sourceCleanup = performance.now() - phaseStartedAt;
        if (exitCode !== 0) {
            const details = recentFfmpegLogs.slice(-4).join(" | ");
            throw new Error(`影片處理失敗（FFmpeg 結束碼 ${exitCode}）。${details}`);
        }

        phaseStartedAt = performance.now();
        result = await engine.readFile(outputFile);
        timings.outputRead = performance.now() - phaseStartedAt;
        if (!(result instanceof Uint8Array) || result.byteLength === 0) {
            throw new Error("處理完成但沒有輸出影片，請確認來源格式、裁切區間與所選編碼選項。");
        }
        phaseStartedAt = performance.now();
        await engine.deleteFile(outputFile);
        outputFileMayExist = false;
        timings.outputCleanup = performance.now() - phaseStartedAt;
        phaseStartedAt = performance.now();
        const outputBlob = new Blob([result], {
            type: options.encodeVideo ? "video/mp4" : sourceFile.type || "application/octet-stream"
        });
        result.fill(0);
        result = null;
        timings.outputBlob = performance.now() - phaseStartedAt;
        const outputName = `${baseName}_${options.encodeVideo ? "edited" : "trimmed"}${outputExtension}`;
        phaseStartedAt = performance.now();
        if (saveHandle) {
            const writable = await saveHandle.createWritable();
            await writable.write(outputBlob);
            await writable.close();
        } else {
            outputUrl = URL.createObjectURL(outputBlob);
            elements.download.href = outputUrl;
            elements.download.download = outputName;
            elements.download.hidden = false;
            elements.download.click();
            const downloadUrl = outputUrl;
            window.setTimeout(() => {
                URL.revokeObjectURL(downloadUrl);
                if (outputUrl === downloadUrl) {
                    outputUrl = null;
                    elements.download.removeAttribute("href");
                    elements.download.hidden = true;
                }
            }, 60_000);
        }
        timings.save = performance.now() - phaseStartedAt;
        const mode = options.encodeVideo ? "重新編碼完成" : "封包複製完成，影片未重新編碼";
        const destination = saveHandle
            ? `已儲存 ${saveHandle.name}`
            : `已觸發下載 ${outputName}；若未開始可點下方連結重試`;
        setStatus(`${mode}（${readMode.toUpperCase()}），${destination}（${formatFileSize(outputBlob.size)}）。`, "success");
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            setStatus("已取消儲存，影片未裁切。");
        } else {
            setStatus(error instanceof Error ? error.message : String(error), "error");
        }
    } finally {
        activeProcessingMode = "copy";
        const cleanupStartedAt = performance.now();
        const cleanupErrors = [];
        const cleanup = async (label, action) => {
            try {
                await action();
            } catch (error) {
                cleanupErrors.push(label);
                console.error(`無法清除${label}：`, error);
            }
        };
        const deleteFileIfPresent = async path => {
            const separator = path.lastIndexOf("/");
            const directory = separator === 0 ? "/" : path.slice(0, separator);
            const name = path.slice(separator + 1);
            const entries = await engine.listDir(directory);
            if (entries.some(entry => entry.name === name && !entry.isDir)) {
                await engine.deleteFile(path);
            }
        };
        if (outputFileMayExist && engine) {
            await cleanup("輸出暫存檔", async () => {
                await deleteFileIfPresent(outputFile);
                outputFileMayExist = false;
            });
        }
        if (inputFileMayExist && engine) {
            await cleanup("MEMFS 來源檔", async () => {
                await deleteFileIfPresent(inputPath);
                inputFileMayExist = false;
            });
        }
        if (mounted && engine) {
            await cleanup("WORKERFS 來源掛載", async () => {
                await engine.unmount(mountPoint);
                mounted = false;
            });
        }
        if (inputDirectoryCreated && engine) {
            await cleanup("本機影片暫存目錄", async () => {
                await engine.deleteDir(mountPoint);
                inputDirectoryCreated = false;
            });
        }
        if (sourceData?.byteLength) sourceData.fill(0);
        sourceData = null;
        if (result?.byteLength) result.fill(0);
        result = null;
        if (totalStartedAt !== null) {
            const sourcePreparation = (timings.sourceRead || 0) + (timings.sourceWrite || timings.sourceMount || 0);
            const outputPreparation = (timings.outputRead || 0) + (timings.outputBlob || 0);
            timings.cleanup = performance.now() - cleanupStartedAt;
            timings.processing = sourcePreparation + (timings.ffmpeg || 0) + outputPreparation;
            timings.total = performance.now() - totalStartedAt;
            console.info("[video-trimmer] 處理階段計時", {
                readMode: readMode.toUpperCase(),
                sourceSize: formatFileSize(sourceFile.size),
                ...Object.fromEntries(Object.entries(timings).map(([stage, elapsed]) => [
                    stage,
                    `${formatElapsed(elapsed)} (${Math.round(elapsed)} ms)`
                ]))
            });
        }
        if (cleanupErrors.length) {
            setStatus(`${elements.status.textContent} 暫存清理失敗：${cleanupErrors.join("、")}，請重新載入頁面釋放資源。`, "error");
        } else if (totalStartedAt !== null) {
            const sourcePreparation = (timings.sourceRead || 0) + (timings.sourceWrite || timings.sourceMount || 0);
            const outputPreparation = (timings.outputRead || 0) + (timings.outputBlob || 0);
            setStatus(`${elements.status.textContent} 階段耗時：${readMode.toUpperCase()} 來源 ${formatElapsed(sourcePreparation)}、FFmpeg ${formatElapsed(timings.ffmpeg || 0)}、輸出 ${formatElapsed(outputPreparation)}、處理合計 ${formatElapsed(timings.processing)}、總計 ${formatElapsed(timings.total)}。`, elements.status.dataset.state);
        }
        setBusy(false);
    }
}

elements.file.addEventListener("change", () => {
    const file = elements.file.files?.[0] ?? null;
    clearDownload();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    selectedFile = file;
    updateMemoryWarning();
    elements.preview.removeAttribute("src");
    elements.preview.load();
    elements.duration.textContent = "總長度 —";
    elements.playbackTime.textContent = formatTime(0);
    elements.timelineTrack.style.setProperty("--start-position", "0%");
    elements.timelineTrack.style.setProperty("--end-position", "100%");
    elements.timelineTrack.style.setProperty("--play-position", "0%");
    elements.start.value = "0";
    elements.end.value = "0";
    elements.startRange.value = "0";
    elements.endRange.value = "0";
    elements.startRangeLabel.textContent = formatTime(0);
    elements.endRangeLabel.textContent = formatTime(0);
    elements.resolution.value = "auto";
    updateCompressionControls();
    cropCenter = { x: 0.5, y: 0.5 };
    updateCropFrame();

    if (!file) {
        elements.fileName.textContent = "尚未選取影片";
        setStatus("請先選擇影片。");
        setBusy(false);
        return;
    }

    previewUrl = URL.createObjectURL(file);
    elements.preview.src = previewUrl;
    elements.fileName.textContent = `${file.name}（${formatFileSize(file.size)}）`;
    elements.preview.onloadedmetadata = () => {
        if (!Number.isFinite(elements.preview.duration)) {
            setBusy(false);
            elements.duration.textContent = "總長度無法讀取";
            setStatus("無法讀取影片長度；請手動輸入起訖秒數後嘗試本機處理。", "error");
            return;
        }
        elements.duration.textContent = `總長度 ${formatTime(elements.preview.duration)}`;
        elements.end.value = elements.preview.duration.toFixed(2);
        elements.start.max = String(elements.preview.duration);
        elements.end.max = String(elements.preview.duration);
        updateRangeControls();
        updateCropFrame();
        updateCompressionControls();
        setBusy(false);
        setStatus("影片已載入；選擇要保留的開始與結束時間。");
    };
    elements.preview.onerror = () => {
        elements.duration.textContent = "總長度無法預覽";
        setStatus("無法在此瀏覽器預覽影片；請手動輸入起訖秒數後嘗試本機處理。", "error");
    };
    setBusy(false);
    elements.markStart.disabled = false;
    elements.markEnd.disabled = false;
});

elements.markStart.addEventListener("click", () => markTime(elements.start));
elements.markEnd.addEventListener("click", () => markTime(elements.end));
elements.start.addEventListener("input", () => updateRangeControls("start"));
elements.end.addEventListener("input", () => updateRangeControls("end"));
elements.preview.addEventListener("timeupdate", updatePlaybackPosition);
elements.preview.addEventListener("seeked", updatePlaybackPosition);
elements.startRange.addEventListener("input", () => {
    const start = Number(elements.startRange.value);
    const end = Number(elements.end.value);
    elements.start.value = Math.min(start, Math.max(0, end - 0.01)).toFixed(2);
    updateRangeControls("start");
});
elements.endRange.addEventListener("input", () => {
    const end = Number(elements.endRange.value);
    const start = Number(elements.start.value);
    elements.end.value = Math.max(end, start + 0.01).toFixed(2);
    updateRangeControls("end");
});
elements.aspectRatio.addEventListener("change", () => {
    cropCenter = { x: 0.5, y: 0.5 };
    updateCropFrame();
    updateActionLabel();
});
for (const control of [elements.ratioWidth, elements.ratioHeight]) {
    control.addEventListener("input", () => {
        updateCropFrame();
        updateActionLabel();
    });
}
elements.rotation.addEventListener("change", () => {
    updateCropFrame();
    updateActionLabel();
});
elements.removeAudio.addEventListener("change", updateActionLabel);
elements.compressVideo.addEventListener("change", () => {
    elements.compressionOptions.hidden = !elements.compressVideo.checked;
    updateActionLabel();
});
elements.resolution.addEventListener("change", updateActionLabel);
elements.readMode.addEventListener("change", () => updateMemoryWarning());
elements.memfsThreshold.addEventListener("change", () => {
    const thresholdMb = Number(elements.memfsThreshold.value);
    if (!Number.isInteger(thresholdMb) || thresholdMb < 64 || thresholdMb > 2048) {
        elements.memfsThreshold.value = String(DEFAULT_MEMFS_THRESHOLD_MB);
        setStatus("MEMFS 檔案大小門檻須介於 64 至 2048 MB。", "error");
        updateMemoryWarning();
        return;
    }
    updateMemoryWarning();
});
elements.startRange.addEventListener("pointerdown", () => {
    elements.startRange.style.zIndex = "5";
    elements.endRange.style.zIndex = "4";
});
elements.endRange.addEventListener("pointerdown", () => {
    elements.startRange.style.zIndex = "4";
    elements.endRange.style.zIndex = "5";
});
for (const range of [elements.startRange, elements.endRange]) {
    range.addEventListener("blur", () => {
        elements.startRange.style.zIndex = "";
        elements.endRange.style.zIndex = "";
    });
}
window.addEventListener("resize", updateCropFrame);
elements.cropFrame.addEventListener("pointerdown", event => {
    if (elements.cropFrame.hidden) return;
    cropDrag = { pointerX: event.clientX, pointerY: event.clientY, center: { ...cropCenter } };
    elements.cropFrame.setPointerCapture(event.pointerId);
    event.preventDefault();
});
elements.cropFrame.addEventListener("pointermove", event => {
    if (!cropDrag) return;
    const ratio = getSourceCropAspectRatio(getSelectedAspectRatio());
    if (!ratio) return;
    const rect = getCropFrameRect(ratio);
    cropCenter = {
        x: Math.max(0, Math.min(1, cropDrag.center.x + (event.clientX - cropDrag.pointerX) / rect.content.width)),
        y: Math.max(0, Math.min(1, cropDrag.center.y + (event.clientY - cropDrag.pointerY) / rect.content.height))
    };
    updateCropFrame();
});
for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    elements.cropFrame.addEventListener(eventName, () => { cropDrag = null; });
}
elements.cropFrame.addEventListener("keydown", event => {
    const ratio = getSourceCropAspectRatio(getSelectedAspectRatio());
    if (!ratio) return;
    const step = event.shiftKey ? 0.05 : 0.01;
    if (event.key === "ArrowLeft") cropCenter.x -= step;
    else if (event.key === "ArrowRight") cropCenter.x += step;
    else if (event.key === "ArrowUp") cropCenter.y -= step;
    else if (event.key === "ArrowDown") cropCenter.y += step;
    else return;
    event.preventDefault();
    cropCenter.x = Math.max(0, Math.min(1, cropCenter.x));
    cropCenter.y = Math.max(0, Math.min(1, cropCenter.y));
    updateCropFrame();
});
elements.trim.addEventListener("click", trimVideo);

window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    installPrompt = event;
    elements.install.hidden = false;
});

elements.install.addEventListener("click", async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    elements.install.hidden = true;
});

window.addEventListener("appinstalled", () => {
    elements.install.hidden = true;
    elements.pwaStatus.textContent = "PWA 已安裝";
});

if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js")
        .then(() => { elements.pwaStatus.textContent = "PWA 可安裝；離線需先載入處理引擎"; })
        .catch(error => {
            elements.pwaStatus.textContent = "PWA 離線快取無法啟用";
            console.error("Service worker 註冊失敗：", error);
        });
} else {
    elements.pwaStatus.textContent = "請透過 localhost 或 HTTPS 啟用 PWA";
}

window.addEventListener("pagehide", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (outputUrl) URL.revokeObjectURL(outputUrl);
});
