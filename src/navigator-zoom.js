"use strict";

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 12800;
const SLIDER_MAX = 1000;
const LOG_RANGE = Math.log(MAX_ZOOM / MIN_ZOOM);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteValue(value) {
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function zoomToSlider(percent) {
  const value = finiteValue(percent);
  if (value == null) return null;
  const bounded = clamp(value, MIN_ZOOM, MAX_ZOOM);
  return Math.round(Math.log(bounded / MIN_ZOOM) / LOG_RANGE * SLIDER_MAX);
}

function sliderToZoom(position) {
  const value = finiteValue(position);
  if (value == null) return null;
  const bounded = clamp(Math.round(value), 0, SLIDER_MAX);
  if (bounded === 0) return MIN_ZOOM;
  if (bounded === SLIDER_MAX) return MAX_ZOOM;
  const percent = MIN_ZOOM * Math.exp(LOG_RANGE * bounded / SLIDER_MAX);
  return clamp(Number(percent.toFixed(2)), MIN_ZOOM, MAX_ZOOM);
}

const STEP_ZOOMS = Object.freeze([
  0.08, 0.1, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 0.8,
  1, 1.25, 1.5, 2, 3, 4, 5, 6.25, 8.33, 12.5, 16.67, 25, 33.33,
  50, 66.67, 100, 200, 300, 400, 500, 600, 800, 1200, 1600, 3200,
  6400, 12800
]);

function documentId(doc) {
  try {
    const id = doc && doc.id;
    return typeof id === "number" && Number.isFinite(id) && id >= 0 ? id : null;
  } catch (_) {
    return null;
  }
}

function readZoom(doc) {
  try {
    const zoom = doc && doc.zoom;
    return typeof zoom === "number" && Number.isFinite(zoom) && zoom > 0 ? zoom : null;
  } catch (_) {
    return null;
  }
}

function isCancelled(context) {
  try {
    return !!context && context.isCancelled === true;
  } catch (_) {
    return true;
  }
}

function actionError(result) {
  if (!Array.isArray(result)) throw new Error("Photoshop 未返回视图缩放结果。");
  for (const item of result) {
    if (!item || typeof item !== "object") continue;
    const code = typeof item.result === "number" ? item.result
      : (typeof item.error === "number" ? item.error : null);
    if (item._obj === "error" || (code != null && code < 0)) {
      const error = new Error(typeof item.message === "string" && item.message
        ? item.message : "Photoshop 拒绝了视图缩放操作。");
      error.photoshopResult = code;
      throw error;
    }
  }
}

function createNavigatorZoom(options) {
  const config = options || {};
  const ps = config.ps;
  const getActiveDocument = typeof config.getActiveDocument === "function"
    ? config.getActiveDocument : () => null;
  const canWrite = typeof config.canWrite === "function" ? config.canWrite : () => false;
  const render = typeof config.render === "function" ? config.render : () => {};
  const onError = typeof config.onError === "function" ? config.onError : null;
  const onViewChange = typeof config.onViewChange === "function" ? config.onViewChange : () => {};

  let supported = false;
  try {
    supported = !!ps && !!ps.core && typeof ps.core.executeAsModal === "function" &&
      !!ps.action && typeof ps.action.batchPlay === "function";
  } catch (_) {}

  let started = false;
  let epoch = 0;
  let requestSerial = 0;
  let currentDocument = null;
  let currentDocumentId = null;
  let currentZoom = null;
  let desiredZoom = null;
  let desiredSerial = null;
  let pendingRequest = null;
  let inFlight = false;
  let unsupportedReported = false;
  let readReported = false;

  function reportError(error, detail) {
    if (!onError) return;
    try { onError(error, detail || null); } catch (_) {}
  }

  function canWriteNow() {
    try { return !!canWrite(currentDocument, currentDocumentId); } catch (_) { return false; }
  }

  function safeActiveDocument() {
    try { return getActiveDocument() || null; } catch (_) { return null; }
  }

  function publish() {
    if (!started) return;
    try {
      render({
        documentId: currentDocumentId,
        zoom: desiredZoom != null ? desiredZoom : currentZoom,
        busy: inFlight || !!pendingRequest,
        enabled: currentDocumentId != null && currentZoom != null && supported && canWriteNow()
      });
    } catch (error) {
      reportError(error, { stage: "render" });
    }
  }

  function publishStopped() {
    try {
      render({ documentId: null, zoom: null, busy: false, enabled: false });
    } catch (error) {
      reportError(error, { stage: "render" });
    }
  }

  function reportUnsupported() {
    if (unsupportedReported) return;
    unsupportedReported = true;
    reportError(new Error("当前 Photoshop 环境不支持视图缩放操作。"), { stage: "unsupported" });
  }

  function reportZoomReadFailure() {
    if (readReported) return;
    readReported = true;
    reportError(new Error("当前 Photoshop 环境无法读取文档缩放比例。"), { stage: "readZoom" });
  }

  function clearDocument() {
    epoch++;
    currentDocument = null;
    currentDocumentId = null;
    currentZoom = null;
    desiredZoom = null;
    desiredSerial = null;
    pendingRequest = null;
  }

  function isCurrent(job) {
    return started && epoch === job.epoch && currentDocumentId === job.documentId;
  }

  function invalidateSwitchedDocument(job) {
    if (!isCurrent(job)) return;
    clearDocument();
    publish();
  }

  function syncActualZoom(job) {
    if (!isCurrent(job)) return false;
    const active = safeActiveDocument();
    if (documentId(active) !== job.documentId) {
      invalidateSwitchedDocument(job);
      return false;
    }
    currentDocument = active;
    const zoom = readZoom(active);
    if (zoom == null) {
      currentZoom = null;
      reportZoomReadFailure();
      return false;
    }
    currentZoom = zoom;
    return true;
  }

  function defer(job) {
    if (!isCurrent(job)) return;
    if (!pendingRequest && desiredSerial === job.serial) {
      pendingRequest = job;
    }
  }

  function makeDescriptor(job) {
    const descriptor = {
      _obj: "setPanZoom",
      _target: [{ _ref: "document", _id: job.documentId }],
      z: { _unit: "percentUnit", _value: job.percent / 100 },
      resize: false,
      animate: false,
      _options: { dialogOptions: "dontDisplay" }
    };
    if (job.kind === "pan") {
      descriptor.x = { _unit: "pixelsUnit", _value: job.x };
      descriptor.y = { _unit: "pixelsUnit", _value: job.y };
    }
    return descriptor;
  }

  async function executeRequest(job) {
    let enteredModal = false;
    let outcome = "failure";
    let failure = null;
    try {
      const result = await ps.core.executeAsModal(async context => {
        enteredModal = true;
        if (!isCurrent(job)) return "stale";
        if (isCancelled(context)) return "deferred";
        if (!canWriteNow()) return "deferred";

        const active = safeActiveDocument();
        if (documentId(active) !== job.documentId) return "stale-active";
        // A pan was calibrated at one zoom. Never restore an obsolete zoom
        // if the user zoomed through Photoshop while this job was waiting.
        if (job.kind === "pan" && Math.abs(readZoom(active) - job.percent) > 0.001) return "stale-zoom";
        const batchPlay = ps.action && ps.action.batchPlay;
        if (typeof batchPlay !== "function") {
          throw new Error("当前 Photoshop 环境不支持视图缩放操作。");
        }
        actionError(await batchPlay.call(ps.action, [makeDescriptor(job)], {}));
        return "success";
      }, { commandName: job.kind === "pan" ? "移动文档视图" : "缩放文档视图", timeOut: 0 });

      if (result === "success") outcome = "success";
      else if (result === "deferred" || !enteredModal) outcome = "deferred";
      else if (result === "stale-active") outcome = "stale-active";
      else if (result === "stale-zoom") outcome = "stale-zoom";
      else outcome = "stale";
    } catch (error) {
      failure = error;
      // A modal rejected before its callback ran because Photoshop was occupied.
      // Keep the latest request, then retry only on the next external update.
      outcome = enteredModal ? "failure" : "deferred";
    } finally {
      inFlight = false;

      if (isCurrent(job)) {
        if (outcome === "deferred") {
          defer(job);
        } else if (outcome === "stale-active") {
          invalidateSwitchedDocument(job);
        } else if (outcome === "success" || outcome === "failure" || outcome === "stale-zoom") {
          syncActualZoom(job);
          if (!pendingRequest && desiredSerial === job.serial) {
            desiredZoom = null;
            desiredSerial = null;
          }
          if (outcome === "failure" && isCurrent(job) && !pendingRequest && failure) {
            reportError(failure, { stage: job.kind === "pan" ? "setPan" : "setZoom", documentId: job.documentId });
          }
        }

        if (started) publish();
        if (outcome === "success") {
          try { onViewChange(job.documentId); } catch (_) {}
        }
      } else if (started) {
        publish();
      }

      // A successful or failed request can hand off immediately to the latest
      // queued value. Deferred work waits for update() to avoid retry loops.
      if (outcome !== "deferred" && started && pendingRequest && canWriteNow()) {
        pump();
      }
    }
  }

  function pump() {
    if (!started || inFlight || !pendingRequest || !supported) return;
    if (!canWriteNow()) return;

    const job = pendingRequest;
    if (!isCurrent(job)) {
      pendingRequest = null;
      if (desiredSerial === job.serial) {
        desiredZoom = null;
        desiredSerial = null;
      }
      publish();
      return;
    }

    const active = safeActiveDocument();
    if (documentId(active) !== job.documentId) {
      invalidateSwitchedDocument(job);
      return;
    }

    pendingRequest = null;
    inFlight = true;
    publish();
    void executeRequest(job);
  }

  function start() {
    started = true;
  }

  function stop() {
    started = false;
    epoch++;
    currentDocument = null;
    currentDocumentId = null;
    currentZoom = null;
    desiredZoom = null;
    desiredSerial = null;
    pendingRequest = null;
    publishStopped();
  }

  function update(doc) {
    if (!started) return;
    const candidate = arguments.length ? doc : safeActiveDocument();
    const id = documentId(candidate);
    if (id == null) {
      if (currentDocumentId != null || desiredZoom != null || pendingRequest) clearDocument();
      publish();
      return;
    }

    if (id !== currentDocumentId) {
      epoch++;
      currentDocument = candidate;
      currentDocumentId = id;
      currentZoom = readZoom(candidate);
      desiredZoom = null;
      desiredSerial = null;
      pendingRequest = null;
    } else {
      currentDocument = candidate;
      const actualZoom = readZoom(candidate);
      if (actualZoom != null) currentZoom = actualZoom;
    }

    if (currentZoom == null) reportZoomReadFailure();
    if (!supported) reportUnsupported();

    // While a drag request is pending or executing, retain its optimistic value
    // instead of replacing the slider with the older polled host value.
    publish();
    pump();
  }

  function request(percent) {
    const number = finiteValue(percent);
    if (!started || currentDocumentId == null || currentZoom == null || !supported || number == null) return false;

    const value = clamp(number, MIN_ZOOM, MAX_ZOOM);
    const serial = ++requestSerial;
    const job = { kind: "zoom", documentId: currentDocumentId, epoch, percent: value, serial };
    desiredZoom = value;
    desiredSerial = serial;
    pendingRequest = job;
    publish();
    pump();
    return true;
  }

  function requestPan(view) {
    if (!view || !started || !supported || currentDocumentId == null || desiredZoom != null || !canWriteNow()) return false;
    if (view.documentId !== currentDocumentId || !Number.isFinite(view.zoom) ||
        !Number.isFinite(view.x) || !Number.isFinite(view.y)) return false;
    const actual = readZoom(safeActiveDocument());
    if (documentId(safeActiveDocument()) !== currentDocumentId || actual == null ||
        Math.abs(actual - view.zoom) > 0.001) return false;
    currentZoom = actual;
    const serial = ++requestSerial;
    pendingRequest = { kind: "pan", documentId: currentDocumentId, epoch, serial,
      percent: actual, x: view.x, y: view.y };
    desiredSerial = serial;
    publish();
    pump();
    return true;
  }

  function step(direction) {
    const value = finiteValue(direction);
    if (value == null || value === 0) return false;
    const current = desiredZoom != null ? desiredZoom : currentZoom;
    if (current == null) return false;

    if (value > 0) {
      for (const zoom of STEP_ZOOMS) {
        if (zoom > current + 0.00001) return request(zoom);
      }
      return false;
    }
    for (let i = STEP_ZOOMS.length - 1; i >= 0; i--) {
      if (STEP_ZOOMS[i] < current - 0.00001) return request(STEP_ZOOMS[i]);
    }
    return false;
  }

  return { start, stop, update, request, requestPan, step };
}

module.exports = {
  MIN_ZOOM,
  MAX_ZOOM,
  SLIDER_MAX,
  zoomToSlider,
  sliderToZoom,
  createNavigatorZoom
};
