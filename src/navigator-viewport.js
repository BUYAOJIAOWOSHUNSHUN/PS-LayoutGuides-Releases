"use strict";

function numeric(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let result;
  try {
    result = Number(value);
    if (!Number.isFinite(result) && typeof value === "object" && "value" in value) {
      result = Number(value.value);
    }
    if (!Number.isFinite(result) && typeof value === "object" && "_value" in value) {
      result = Number(value._value);
    }
  } catch (_) { return null; }
  return Number.isFinite(result) ? result : null;
}

function readBounds(info) {
  if (!info || typeof info !== "object") return null;
  let source = info;
  try {
    if (source.viewInfo && typeof source.viewInfo === "object") source = source.viewInfo;
    source = source.activeView && source.activeView.globalBounds;
  } catch (_) { return null; }
  if (!source || typeof source !== "object") return null;
  let left, top, right, bottom;
  try {
    left = numeric(source.left);
    top = numeric(source.top);
    right = numeric(source.right);
    bottom = numeric(source.bottom);
  } catch (_) { return null; }
  if ([left, top, right, bottom].some(value => value == null) || right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

function readMatrix(transform) {
  let values = transform;
  if (values && !Array.isArray(values) && typeof values === "object") {
    try {
      if (Array.isArray(values.viewTransform)) values = values.viewTransform;
      else if (Array.isArray(values._value)) values = values._value;
      else if (Array.isArray(values.value)) values = values.value;
    } catch (_) { return null; }
  }
  if (!Array.isArray(values) || values.length < 6) return null;
  const matrix = values.slice(0, 6).map(numeric);
  if (matrix.some(value => value == null)) return null;
  const [a, b, c, d, tx, ty] = matrix;
  const epsilon = 1e-9 * Math.max(1, Math.abs(a), Math.abs(d));
  if (Math.abs(b) > epsilon || Math.abs(c) > epsilon || a <= 0 || d <= 0) return null;
  return { a, d, tx, ty };
}

function readScale(bounds, displays, platform) {
  if (platform === "darwin") return 1;
  if (platform !== "win32" || !Array.isArray(displays)) return null;

  for (const display of displays) {
    if (!display || typeof display !== "object") continue;
    let area, scale;
    try {
      area = display.globalBounds;
      scale = numeric(display.scaleFactor);
    } catch (_) { continue; }
    if (!area || scale == null || scale <= 0) continue;
    let left, top, right, bottom;
    try {
      left = numeric(area.left);
      top = numeric(area.top);
      right = numeric(area.right);
      bottom = numeric(area.bottom);
    } catch (_) { continue; }
    if ([left, top, right, bottom].some(value => value == null)) continue;
    if (bounds.left >= left && bounds.left < right && bounds.top >= top && bounds.top < bottom) {
      return scale;
    }
  }
  return null;
}

function documentIdIsValid(id) {
  return (typeof id === "number" && Number.isFinite(id) && id >= 0) ||
    (typeof id === "string" && id.length > 0);
}

function computeViewport(input) {
  const config = input || {};
  const documentId = config.documentId;
  const width = numeric(config.width);
  const height = numeric(config.height);
  const zoom = numeric(config.zoom);
  if (!documentIdIsValid(documentId) || width == null || height == null || width <= 0 || height <= 0 ||
      zoom == null || zoom <= 0) return null;

  const bounds = readBounds(config.viewInfo);
  const matrix = readMatrix(config.viewTransform);
  const scale = bounds && readScale(bounds, config.displays, config.platform);
  if (!bounds || !matrix || scale == null) return null;

  // Photoshop's native view bounds include the final physical pixel. Convert
  // that inclusive extent to panel-local logical units before applying M.
  const viewWidth = (bounds.right - bounds.left + 1) / scale;
  const viewHeight = (bounds.bottom - bounds.top + 1) / scale;
  const left = matrix.tx;
  const top = matrix.ty;
  const right = matrix.a * viewWidth + matrix.tx;
  const bottom = matrix.d * viewHeight + matrix.ty;
  const centerX = matrix.a * viewWidth / 2 + matrix.tx;
  const centerY = matrix.d * viewHeight / 2 + matrix.ty;
  const panScaleX = 1 / matrix.a;
  const panScaleY = 1 / matrix.d;
  if ([viewWidth, viewHeight, left, top, right, bottom, centerX, centerY, panScaleX, panScaleY]
    .some(value => !Number.isFinite(value))) return null;

  const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
  return {
    documentId,
    width,
    height,
    zoom,
    bounds: { left, top, right, bottom },
    center: { x: centerX, y: centerY },
    visible: {
      left: clamp(left, width),
      top: clamp(top, height),
      right: clamp(right, width),
      bottom: clamp(bottom, height)
    },
    panScaleX,
    panScaleY
  };
}

function documentId(doc) {
  if (!doc) return null;
  try { return documentIdIsValid(doc.id) ? doc.id : null; } catch (_) { return null; }
}

function readDocumentNumber(doc, key) {
  try { return numeric(doc[key]); } catch (_) { return null; }
}

function readDocumentSnapshot(doc) {
  if (!doc) return null;
  const width = readDocumentNumber(doc, "width");
  const height = readDocumentNumber(doc, "height");
  const zoom = readDocumentNumber(doc, "zoom");
  if (width == null || height == null || zoom == null || width <= 0 || height <= 0 || zoom <= 0) return null;
  return { width, height, zoom };
}

function sameDocumentSnapshot(first, second) {
  return !!first && !!second && Object.is(first.width, second.width) &&
    Object.is(first.height, second.height) && Object.is(first.zoom, second.zoom);
}

function actionResultValue(result, index, property) {
  if (!Array.isArray(result) || !result[index] || typeof result[index] !== "object") return null;
  const item = result[index];
  if (item._obj === "error" || (typeof item.result === "number" && item.result < 0) ||
      (typeof item.error === "number" && item.error < 0)) {
    throw new Error("Photoshop did not return " + property + ".");
  }
  if (Object.prototype.hasOwnProperty.call(item, property)) return item[property];
  return null;
}

function makeGetDescriptor(property, id) {
  return {
    _obj: "get",
    _target: [
      { _property: property },
      { _ref: "document", _id: id }
    ],
    _options: { dialogOptions: "dontDisplay" }
  };
}

function createNavigatorViewport(options) {
  const config = options || {};
  const ps = config.ps;
  const getActiveDocument = typeof config.getActiveDocument === "function"
    ? config.getActiveDocument : () => null;
  const canRead = typeof config.canRead === "function" ? config.canRead : () => false;
  const render = typeof config.render === "function" ? config.render : () => {};
  let platform = config.platform;
  if (typeof platform !== "string" || !platform) {
    try { platform = require("os").platform(); } catch (_) { platform = null; }
  }

  let supported = false;
  try {
    supported = !!ps && !!ps.action && typeof ps.action.batchPlay === "function" &&
      !!ps.core && typeof ps.core.getDisplayConfiguration === "function";
  } catch (_) {}

  let started = false;
  let epoch = 0;
  let currentDocument = null;
  let currentDocumentId = null;
  let inFlight = false;
  let queuedRead = false;

  function safeRender(value) {
    try { render(value); } catch (_) {}
  }

  function safeActiveDocument() {
    try { return getActiveDocument() || null; } catch (_) { return null; }
  }

  function canReadNow(doc, id) {
    try { return !!canRead(doc, id); } catch (_) { return false; }
  }

  function clearDocument() {
    epoch++;
    currentDocument = null;
    currentDocumentId = null;
    queuedRead = false;
    safeRender(null);
  }

  function activeStillMatches(job) {
    if (!started || epoch !== job.epoch || currentDocumentId !== job.documentId) return false;
    const active = safeActiveDocument();
    if (documentId(active) !== job.documentId) {
      if (epoch === job.epoch && currentDocumentId === job.documentId) clearDocument();
      return false;
    }
    return true;
  }

  async function read(job) {
    try {
      const descriptors = [makeGetDescriptor("viewInfo", job.documentId),
        makeGetDescriptor("viewTransform", job.documentId)];
      const batchPromise = ps.action.batchPlay.call(ps.action, descriptors, {});
      const displayPromise = ps.core.getDisplayConfiguration.call(ps.core, {});
      const [result, displays] = await Promise.all([batchPromise, displayPromise]);
      if (!activeStillMatches(job)) return;

      const viewInfo = actionResultValue(result, 0, "viewInfo");
      const viewTransform = actionResultValue(result, 1, "viewTransform");
      const doc = safeActiveDocument();
      if (!doc || !canReadNow(doc, job.documentId)) return;
      const snapshot = readDocumentSnapshot(doc);
      if (!snapshot) {
        if (activeStillMatches(job)) safeRender(null);
        return;
      }
      if (!sameDocumentSnapshot(job.snapshot, snapshot)) {
        if (activeStillMatches(job) && canReadNow(doc, job.documentId)) queuedRead = true;
        return;
      }
      const viewport = computeViewport({
        documentId: job.documentId,
        width: job.snapshot.width,
        height: job.snapshot.height,
        zoom: job.snapshot.zoom,
        viewInfo,
        viewTransform,
        displays,
        platform
      });
      if (activeStillMatches(job)) safeRender(viewport);
    } catch (_) {
      if (activeStillMatches(job)) safeRender(null);
    } finally {
      inFlight = false;
      if (!started) return;
      if (queuedRead && currentDocumentId != null) {
        queuedRead = false;
        pump();
      }
    }
  }

  function pump() {
    if (!started || inFlight || !supported || currentDocumentId == null) return;
    const id = currentDocumentId;
    const doc = safeActiveDocument();
    if (!doc) {
      safeRender(null);
      return;
    }
    if (documentId(safeActiveDocument()) !== id) {
      if (currentDocumentId === id) clearDocument();
      return;
    }
    currentDocument = doc;
    if (!canReadNow(doc, id)) {
      return;
    }
    const snapshot = readDocumentSnapshot(doc);
    if (!snapshot) {
      safeRender(null);
      return;
    }
    inFlight = true;
    void read({ documentId: id, epoch, snapshot });
  }

  function start() {
    if (started) return;
    started = true;
    safeRender(null);
  }

  function stop() {
    started = false;
    epoch++;
    currentDocument = null;
    currentDocumentId = null;
    queuedRead = false;
    safeRender(null);
  }

  function update(doc) {
    if (!started) return;
    const candidate = arguments.length ? doc : safeActiveDocument();
    const id = documentId(candidate);
    if (id == null) {
      if (currentDocumentId != null) clearDocument();
      else safeRender(null);
      return;
    }

    if (id !== currentDocumentId) {
      epoch++;
      currentDocumentId = id;
      currentDocument = candidate;
      queuedRead = false;
      safeRender(null);
    } else {
      currentDocument = candidate;
    }

    if (!supported) {
      safeRender(null);
      return;
    }
    if (documentId(safeActiveDocument()) !== id) {
      clearDocument();
      return;
    }
    if (!canReadNow(candidate, id)) return;
    if (inFlight) queuedRead = true;
    else pump();
  }

  return {
    start,
    stop,
    update,
    get supported() { return supported; }
  };
}

module.exports = { computeViewport, createNavigatorViewport };
