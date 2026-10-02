"use strict";

const MAX_PREVIEW_WIDTH = 480;
const MAX_PREVIEW_HEIGHT = 240;
const MAX_DOCUMENT_DIMENSION = 300000;
const MAX_VISIBILITY_LAYERS = 5000;
const RETRY_INTERVAL = 5000;
const HISTORY_FALLBACK_INTERVAL = 5000;
const SRGB = "sRGB IEC61966-2.1";

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let number = Number(value);
  if (!Number.isFinite(number) && typeof value === "object" && "value" in value) {
    number = Number(value.value);
  }
  return Number.isFinite(number) ? number : null;
}

function readDimension(doc, name) {
  let value;
  try { value = finiteNumber(doc[name]); } catch (_) { return null; }
  if (value == null || value <= 0 || value > MAX_DOCUMENT_DIMENSION) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function readHistory(doc) {
  try {
    const state = doc.activeHistoryState;
    if (!state) return { readable: false, id: null };
    const id = state.id;
    if ((typeof id !== "number" && typeof id !== "string") || String(id).length === 0) {
      return { readable: false, id: null };
    }
    if (typeof id === "number" && !Number.isFinite(id)) return { readable: false, id: null };
    return { readable: true, id };
  } catch (_) {
    return { readable: false, id: null };
  }
}

function collectionLength(collection) {
  let value;
  try { value = finiteNumber(collection.length); } catch (_) { return null; }
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function readVisibility(doc) {
  let layers;
  try { layers = doc.layers; } catch (_) { return { readable: false, key: null }; }
  // A root document collection must be readable. Photoshop DOM proxies may
  // be callable, so inspect by shape rather than requiring an object type.
  if (layers === undefined) return { readable: false, key: null };
  if (layers === null) return { readable: false, key: null };

  const firstLength = collectionLength(layers);
  if (firstLength == null || firstLength > MAX_VISIBILITY_LAYERS) {
    return { readable: false, key: null };
  }
  let count = 0;
  let signature = "";
  const stack = [{ collection: layers, length: firstLength, index: 0 }];
  signature += firstLength + "[";

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.length) {
      signature += "]";
      stack.pop();
      continue;
    }
    if (count >= MAX_VISIBILITY_LAYERS) return { readable: false, key: null };

    let layer;
    let visible;
    let children;
    try {
      layer = frame.collection[frame.index++];
      if (layer == null) return { readable: false, key: null };
      visible = layer.visible;
      children = layer.layers;
    } catch (_) { return { readable: false, key: null }; }
    if (typeof visible !== "boolean") return { readable: false, key: null };
    count++;
    signature += visible ? "1" : "0";

    // Missing .layers is expected for ordinary Photoshop layers. A present
    // child collection is traversed in DOM order, with the total layer count
    // checked before any child is read.
    if (children === undefined) {
      signature += ";";
      continue;
    }
    if (children === null) return { readable: false, key: null };
    const length = collectionLength(children);
    if (length == null || count + length > MAX_VISIBILITY_LAYERS) {
      return { readable: false, key: null };
    }
    signature += length + "[";
    stack.push({ collection: children, length, index: 0 });
  }
  return { readable: true, key: signature };
}

function inspectDocument(doc) {
  if (doc == null) return null;
  let id;
  try { id = doc.id; } catch (_) { return null; }
  if (typeof id !== "number" || !Number.isFinite(id) || id < 0) return null;

  const width = readDimension(doc, "width");
  const height = readDimension(doc, "height");
  let mode = "UNKNOWN";
  try { if (doc.mode != null) mode = String(doc.mode); } catch (_) {}
  const history = readHistory(doc);
  const visibility = readVisibility(doc);
  const key = JSON.stringify([
    id,
    history.readable ? [typeof history.id, history.id] : null,
    visibility.readable ? visibility.key : null,
    width,
    height,
    mode
  ]);
  if (!width || !height) return { id, width, height, mode, history, key, error: "文档尺寸无效，无法生成预览。" };
  const scale = Math.min(MAX_PREVIEW_WIDTH / width, MAX_PREVIEW_HEIGHT / height);
  const targetWidth = Math.max(1, Math.min(MAX_PREVIEW_WIDTH, Math.round(width * scale)));
  const targetHeight = Math.max(1, Math.min(MAX_PREVIEW_HEIGHT, Math.round(height * scale)));
  return {
    id, width, height, mode, history, visibility, key,
    targetWidth, targetHeight
  };
}

function safelyDispose(imageData) {
  if (!imageData || typeof imageData.dispose !== "function") return;
  try { imageData.dispose(); } catch (_) {}
}

function stageError(stage, cause) {
  if (cause && cause.navigatorStage) return cause;
  let reason = "未知错误";
  if (typeof cause === "string" && cause) reason = cause;
  else if (cause && typeof cause.message === "string" && cause.message) reason = cause.message;
  const error = new Error(stage + ": " + reason);
  error.navigatorStage = stage;
  error.navigatorCause = cause;
  return error;
}

function stageMessage(stage) {
  const messages = {
    getPixels: "缩略图暂时无法读取，稍后自动重试。",
    getData: "缩略图暂时无法读取，稍后自动重试。",
    createImageData: "缩略图暂时无法生成，稍后自动重试。",
    encode: "缩略图暂时无法生成，稍后自动重试。",
    readScope: "预览暂时不可用，稍后自动重试。"
  };
  return messages[stage] || "缩略图暂时无法生成，稍后自动重试。";
}

function readBounds(value, snapshot, level) {
  if (!value || typeof value !== "object") throw new Error("Photoshop 返回的预览边界无效。");
  const left = finiteNumber(value.left), top = finiteNumber(value.top);
  const right = finiteNumber(value.right), bottom = finiteNumber(value.bottom);
  if ([left, top, right, bottom].some(item => item == null) || right < left || bottom < top) {
    throw new Error("Photoshop 返回的预览边界无效。");
  }
  const cacheScale = Math.pow(2, level);
  const maxCacheX = Math.ceil(snapshot.width / cacheScale) + 1;
  const maxCacheY = Math.ceil(snapshot.height / cacheScale) + 1;
  if (left < 0 || top < 0 || right > maxCacheX || bottom > maxCacheY) {
    throw new Error("Photoshop 返回的预览边界超出画布。");
  }
  return {
    left: Math.max(0, Math.min(snapshot.width, left * cacheScale)),
    top: Math.max(0, Math.min(snapshot.height, top * cacheScale)),
    right: Math.max(0, Math.min(snapshot.width, right * cacheScale)),
    bottom: Math.max(0, Math.min(snapshot.height, bottom * cacheScale))
  };
}

function validImageData(imageData) {
  // PhotoshopImageData is a native UXP proxy. Validate its dimensions and
  // pixel format without relying on JavaScript's typeof classification.
  if (!imageData) {
    throw new Error("Photoshop 没有返回预览像素。");
  }
  const width = finiteNumber(imageData.width), height = finiteNumber(imageData.height);
  const components = finiteNumber(imageData.components);
  const componentSize = finiteNumber(imageData.componentSize);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_PREVIEW_WIDTH || height > MAX_PREVIEW_HEIGHT ||
      width * height > MAX_PREVIEW_WIDTH * MAX_PREVIEW_HEIGHT ||
      components !== 3 || componentSize !== 8 || imageData.colorSpace !== "RGB" ||
      typeof imageData.getData !== "function") {
    throw new Error("Photoshop 返回的预览像素格式或尺寸无效。");
  }
  return { width, height };
}

function composeFullCanvas(sourcePixels, sourceWidth, sourceHeight, sourceBounds, snapshot) {
  const canvasWidth = snapshot.targetWidth;
  const canvasHeight = snapshot.targetHeight;
  const canvas = new Uint8Array(canvasWidth * canvasHeight * 3);
  canvas.fill(255);

  const sourceWidthInDocument = sourceBounds.right - sourceBounds.left;
  const sourceHeightInDocument = sourceBounds.bottom - sourceBounds.top;
  if (sourceWidthInDocument <= 0 || sourceHeightInDocument <= 0) return canvas;

  const x0 = Math.max(0, Math.min(canvasWidth - 1,
    Math.floor(sourceBounds.left * canvasWidth / snapshot.width)));
  const y0 = Math.max(0, Math.min(canvasHeight - 1,
    Math.floor(sourceBounds.top * canvasHeight / snapshot.height)));
  const x1 = Math.max(x0 + 1, Math.min(canvasWidth,
    Math.ceil(sourceBounds.right * canvasWidth / snapshot.width)));
  const y1 = Math.max(y0 + 1, Math.min(canvasHeight,
    Math.ceil(sourceBounds.bottom * canvasHeight / snapshot.height)));
  const destinationWidth = x1 - x0;
  const destinationHeight = y1 - y0;

  // getPixels can return only the non-empty crop. Map that crop back into the
  // requested full-canvas thumbnail; white pixels represent transparent canvas.
  for (let y = 0; y < destinationHeight; y++) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / destinationHeight));
    for (let x = 0; x < destinationWidth; x++) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / destinationWidth));
      const from = (sourceY * sourceWidth + sourceX) * 3;
      const to = ((y0 + y) * canvasWidth + x0 + x) * 3;
      canvas[to] = sourcePixels[from];
      canvas[to + 1] = sourcePixels[from + 1];
      canvas[to + 2] = sourcePixels[from + 2];
    }
  }
  return canvas;
}

function createNavigatorPreview(options) {
  const config = options || {};
  const imaging = config.imaging;
  const getActiveDocument = config.getActiveDocument;
  const canRead = config.canRead;
  const render = config.render;
  if (typeof getActiveDocument !== "function" || typeof canRead !== "function" ||
      typeof render !== "function") {
    throw new TypeError("createNavigatorPreview 需要 getActiveDocument、canRead 和 render。");
  }
  if (config.readScope != null && typeof config.readScope !== "function") {
    throw new TypeError("readScope 必须是函数。");
  }
  const readScope = typeof config.readScope === "function" ? config.readScope : fn => fn();
  let imagingAvailable = false;
  try {
    imagingAvailable = !!imaging && typeof imaging.getPixels === "function" &&
      typeof imaging.createImageDataFromBuffer === "function" &&
      typeof imaging.encodeImageData === "function";
  } catch (_) {}

  const clock = typeof config.now === "function" ? config.now : Date.now;
  let started = false;
  let inFlight = false;
  let epoch = 0;
  let currentKey = null;
  let currentSnapshot = null;
  let readAllowed = false;
  let displayedKey = null;
  let displayedState = null;
  let displayedSrc = null;
  let lastSuccessKey = null;
  let lastSuccessAt = 0;
  let lastAttemptKey = null;
  let lastAttemptAt = 0;

  function now() {
    try {
      const value = Number(clock());
      return Number.isFinite(value) ? value : Date.now();
    } catch (_) { return Date.now(); }
  }

  function activeDocument() {
    try { return getActiveDocument() || null; } catch (_) { return null; }
  }

  function allowedToRead() {
    try { return !!canRead(); } catch (_) { return false; }
  }

  function publish(value, key) {
    try { render(value); } catch (_) {}
    displayedKey = key == null ? null : key;
    displayedState = value.state;
    displayedSrc = value.src || null;
  }

  function publishEmpty() {
    publish({ state: "empty" }, null);
  }

  function jobIsCurrent(job) {
    if (!started || job.epoch !== epoch || currentKey !== job.snapshot.key || !allowedToRead()) return false;
    const active = activeDocument();
    const current = inspectDocument(active);
    return !!current && current.key === job.snapshot.key;
  }

  function executionCancelled(context) {
    try { return !!(context && context.isCancelled); } catch (_) { return true; }
  }

  function jobAborted(job, context) {
    const current = jobIsCurrent(job);
    return !current || executionCancelled(context);
  }

  async function nativePhase(stage, action, job, context) {
    if (jobAborted(job, context)) return { cancelled: true };
    try {
      const value = await action();
      return { value, cancelled: jobAborted(job, context) };
    } catch (error) {
      if (jobAborted(job, context)) return { cancelled: true };
      throw stageError(stage, error);
    }
  }

  function snapshotState(state, snapshot, message, src) {
    const result = { state, documentId: snapshot.id };
    if (snapshot.targetWidth && snapshot.targetHeight) {
      result.width = snapshot.targetWidth;
      result.height = snapshot.targetHeight;
    }
    if (message) result.message = message;
    if (src) result.src = src;
    return result;
  }

  function failCurrent(job, error) {
    if (!jobIsCurrent(job)) return;
    lastSuccessKey = null;
    lastAttemptKey = job.snapshot.key;
    lastAttemptAt = now();
    const stage = error && error.navigatorStage ? error.navigatorStage : "readScope";
    const cause = error && error.navigatorCause ? error.navigatorCause : error;
    try {
      if (typeof console !== "undefined" && console && typeof console.error === "function") {
        console.error("[navigator-preview][" + stage + "]", cause);
      }
    } catch (_) {}
    publish(snapshotState("error", job.snapshot, stageMessage(stage)), job.snapshot.key);
  }

  async function encodePreviewInScope(snapshot, job, executionContext) {
    let sourceImageData = null;
    let canvasImageData = null;
    try {
      if (jobAborted(job, executionContext)) return null;
      if (typeof snapshot.targetWidth !== "number") {
        throw stageError("getPixels", new Error(snapshot.error || "文档尺寸无效。"));
      }
      const request = {
        documentID: snapshot.id,
        sourceBounds: { left: 0, top: 0, right: snapshot.width, bottom: snapshot.height },
        targetSize: { width: snapshot.targetWidth, height: snapshot.targetHeight },
        colorSpace: "RGB",
        colorProfile: SRGB,
        componentSize: 8,
        applyAlpha: true
      };
      const pixelsResult = await nativePhase("getPixels", () => imaging.getPixels(request), job, executionContext);
      const result = pixelsResult.value;
      sourceImageData = result && result.imageData;
      if (pixelsResult.cancelled) return null;
      if (!sourceImageData) throw stageError("getPixels", new Error("Photoshop 没有返回预览像素。"));

      let bounds;
      try {
        const level = finiteNumber(result.level);
        if (!Number.isInteger(level) || level < 0 || level > 30) {
          throw new Error("Photoshop 返回的预览缓存级别无效。");
        }
        bounds = readBounds(result.sourceBounds, snapshot, level);
      } catch (error) { throw stageError("getPixels", error); }

      let canvasPixels;
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
        canvasPixels = new Uint8Array(snapshot.targetWidth * snapshot.targetHeight * 3);
        canvasPixels.fill(255);
      } else {
        let imageSize;
        try { imageSize = validImageData(sourceImageData); }
        catch (error) { throw stageError("getPixels", error); }
        const pixelsResult = await nativePhase("getData", () => sourceImageData.getData({ chunky: true }), job, executionContext);
        if (pixelsResult.cancelled) return null;
        const pixels = pixelsResult.value;
        if (!(pixels instanceof Uint8Array) || pixels.length !== imageSize.width * imageSize.height * 3) {
          throw stageError("getData", new Error("Photoshop 返回的预览像素数据长度无效。"));
        }
        try { canvasPixels = composeFullCanvas(pixels, imageSize.width, imageSize.height, bounds, snapshot); }
        catch (error) { throw stageError("getData", error); }
      }

      const created = await nativePhase("createImageData", () => imaging.createImageDataFromBuffer(canvasPixels, {
        width: snapshot.targetWidth,
        height: snapshot.targetHeight,
        components: 3,
        chunky: true,
        colorProfile: SRGB,
        colorSpace: "RGB"
      }), job, executionContext);
      canvasImageData = created.value || null;
      if (created.cancelled) return null;
      if (!canvasImageData) {
        throw stageError("createImageData", new Error("Photoshop 无法准备预览画布。"));
      }

      const encoded = await nativePhase("encode", () => imaging.encodeImageData({
        imageData: canvasImageData,
        base64: true
      }), job, executionContext);
      if (encoded.cancelled) return null;
      if (typeof encoded.value !== "string" || !encoded.value) {
        throw stageError("encode", new Error("Photoshop 没有返回 JPEG 数据。"));
      }
      return encoded.value;
    } finally {
      safelyDispose(sourceImageData);
      safelyDispose(canvasImageData);
    }
  }

  function startRead(snapshot, backgroundRefresh) {
    if (inFlight || !started || !readAllowed || !snapshot || snapshot.key !== currentKey) return;
    const job = { snapshot, epoch };
    inFlight = true;
    lastAttemptKey = snapshot.key;
    lastAttemptAt = now();
    if (!backgroundRefresh) {
      publish(snapshotState("loading", snapshot), snapshot.key);
    }

    (async function executeRead() {
      let executionContext = null;
      let encoded = null;
      let nativeFailure = null;
      try {
        try {
          await readScope(async context => {
            executionContext = context;
            if (jobAborted(job, executionContext)) return;
            // Keep the original stage/cause: Photoshop can wrap a rejected
            // modal callback and discard custom Error properties.
            try { encoded = await encodePreviewInScope(snapshot, job, executionContext); }
            catch (error) { nativeFailure = error; }
          });
        } catch (error) {
          if (jobAborted(job, executionContext)) return;
          throw stageError("readScope", error);
        }
        if (nativeFailure) throw nativeFailure;
        if (!encoded || jobAborted(job, executionContext)) return;
        const src = "data:image/jpeg;base64," + encoded;
        lastSuccessKey = snapshot.key;
        lastSuccessAt = now();
        lastAttemptKey = null;
        displayedSrc = src;
        publish(snapshotState("ready", snapshot, null, src), snapshot.key);
      } catch (error) {
        failCurrent(job, error);
      } finally {
        inFlight = false;
        pump();
      }
    })();
  }

  function pump() {
    if (!started || inFlight || !readAllowed || !currentSnapshot || currentSnapshot.key !== currentKey) return;
    if (!allowedToRead()) {
      readAllowed = false;
      return;
    }
    const snapshot = currentSnapshot;
    const active = inspectDocument(activeDocument());
    if (!active || active.key !== snapshot.key) return;
    const timestamp = now();
    if (snapshot.error) {
      if (displayedKey !== snapshot.key || displayedState !== "error") {
        publish(snapshotState("error", snapshot, snapshot.error), snapshot.key);
      }
      return;
    }
    if (!imagingAvailable) {
      if (displayedKey !== snapshot.key || displayedState !== "error") {
        lastAttemptKey = snapshot.key;
        lastAttemptAt = timestamp;
        publish(snapshotState("error", snapshot, "Photoshop Imaging API 不可用，无法生成文档预览。"), snapshot.key);
      }
      return;
    }
    if (lastSuccessKey === snapshot.key) {
      if (snapshot.history.readable && snapshot.visibility.readable) return;
      if (timestamp - lastSuccessAt < HISTORY_FALLBACK_INTERVAL) return;
    }
    if (lastAttemptKey === snapshot.key && timestamp - lastAttemptAt < RETRY_INTERVAL) return;

    const backgroundRefresh = lastSuccessKey === snapshot.key && displayedState === "ready" && !!displayedSrc;
    startRead(snapshot, backgroundRefresh);
  }

  function update(doc) {
    if (!started) return;
    // Use the polled document for change detection. Async reads still verify
    // against getActiveDocument so stale or closed documents cannot publish.
    const snapshot = inspectDocument(arguments.length ? doc : activeDocument());
    if (!snapshot) {
      if (currentKey !== null || displayedState !== "empty") {
        epoch++;
        currentKey = null;
        currentSnapshot = null;
        readAllowed = false;
        lastSuccessKey = null;
        lastAttemptKey = null;
        displayedSrc = null;
        publishEmpty();
      }
      return;
    }

    const changed = snapshot.key !== currentKey;
    if (changed) {
      epoch++;
      currentKey = snapshot.key;
      currentSnapshot = snapshot;
      lastSuccessKey = null;
      lastAttemptKey = null;
      displayedSrc = null;
      publish(snapshotState("loading", snapshot), snapshot.key);
    } else {
      currentSnapshot = snapshot;
    }
    readAllowed = allowedToRead();
    if (!readAllowed) {
      if (changed) publish(snapshotState("loading", snapshot, "等待 Photoshop 空闲后刷新预览。"), snapshot.key);
      return;
    }
    pump();
  }

  function start() {
    started = true;
  }

  function stop() {
    started = false;
    epoch++;
    currentKey = null;
    currentSnapshot = null;
    readAllowed = false;
    lastSuccessKey = null;
    lastAttemptKey = null;
    displayedSrc = null;
    publishEmpty();
  }

  return { start, stop, update };
}

module.exports = { createNavigatorPreview };
