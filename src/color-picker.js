"use strict";

// Standalone, non-destructive color dialog for the canvas-extension swatch.
// This module deliberately has no Photoshop dependency and never writes host
// foreground/background colors or document state.

let nextDialogId = 1;

function channel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function normalizeRgb(rgb) {
  const source = Array.isArray(rgb) ? { r: rgb[0], g: rgb[1], b: rgb[2] } : (rgb || {});
  return { r: channel(source.r), g: channel(source.g), b: channel(source.b) };
}

function rgbToHex(rgb) {
  const color = normalizeRgb(rgb);
  const hex = value => value.toString(16).padStart(2, "0").toUpperCase();
  return "#" + hex(color.r) + hex(color.g) + hex(color.b);
}

function hexToRgb(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

function rgbToHsv(rgb) {
  const color = normalizeRgb(rgb);
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;

  if (delta !== 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  if (h < 0) h += 360;

  return {
    h: h,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100
  };
}

function bounded(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function hsvToRgb(hsv) {
  const source = hsv || {};
  let h = Number(source.h);
  if (!Number.isFinite(h)) h = 0;
  h = ((h % 360) + 360) % 360;
  const s = bounded(source.s, 0, 100) / 100;
  const v = bounded(source.v, 0, 100) / 100;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - chroma;
  let r = 0;
  let g = 0;
  let b = 0;

  if (h < 60) { r = chroma; g = x; }
  else if (h < 120) { r = x; g = chroma; }
  else if (h < 180) { g = chroma; b = x; }
  else if (h < 240) { g = x; b = chroma; }
  else if (h < 300) { r = x; b = chroma; }
  else { r = chroma; b = x; }

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255)
  };
}

function cssColor(rgb) {
  const color = normalizeRgb(rgb);
  return "rgb(" + color.r + ", " + color.g + ", " + color.b + ")";
}

function element(document, tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function displayDecimal(value) {
  return String(Number(Number(value).toFixed(1)));
}

function makeField(document, prefix, key, label, widthClass) {
  const cell = element(document, "div", "cp-channel-cell" + (widthClass ? " " + widthClass : ""));
  const caption = element(document, "span", "cp-channel-label", label);
  const wrap = element(document, "span", "cp-field-wrap");
  const field = element(document, "sp-textfield", "cp-field" + (key === "hex" ? " cp-hex-field" : ""));
  field.id = prefix + key;
  field.setAttribute("aria-label", label);
  field.setAttribute("spellcheck", "false");
  wrap.appendChild(field);
  cell.appendChild(caption);
  cell.appendChild(wrap);
  return field;
}

function pickColor(document, initialRGB) {
  if (!document || typeof document.createElement !== "function") {
    return Promise.reject(new TypeError("pickColor requires a document."));
  }

  const token = nextDialogId++;
  const prefix = "canvas-picker-" + token + "-";
  const initial = normalizeRgb(initialRGB);
  let rgb = { r: initial.r, g: initial.g, b: initial.b };
  let hsv = rgbToHsv(rgb);
  let dragging = "";
  let settled = false;
  const listeners = [];

  const dialog = element(document, "dialog", "cp-dialog");
  dialog.id = prefix + "dialog";
  dialog.setAttribute("aria-label", "选择画布扩展颜色");
  const shell = element(document, "div", "cp-shell");
  const title = element(document, "div", "cp-title", "选择画布扩展颜色");
  const main = element(document, "div", "cp-main");
  const palette = element(document, "div", "cp-palette");
  const sv = element(document, "div", "cp-sv");
  sv.id = prefix + "sv";
  sv.setAttribute("role", "slider");
  sv.setAttribute("aria-label", "饱和度和明度");
  sv.setAttribute("aria-valuemin", "0");
  sv.setAttribute("aria-valuemax", "100");
  sv.setAttribute("tabindex", "0");
  const svMask = element(document, "img", "cp-sv-mask");
  svMask.src = "assets/picker-sv-mask.png";
  svMask.alt = "";
  const svMarker = element(document, "span", "cp-sv-marker");
  sv.appendChild(svMask);
  sv.appendChild(svMarker);

  const hue = element(document, "div", "cp-hue");
  hue.id = prefix + "hue";
  hue.setAttribute("role", "slider");
  hue.setAttribute("aria-label", "色相");
  hue.setAttribute("aria-valuemin", "0");
  hue.setAttribute("aria-valuemax", "360");
  hue.setAttribute("tabindex", "0");
  const hueStrip = element(document, "img", "cp-hue-strip");
  hueStrip.src = "assets/picker-hue.png";
  hueStrip.alt = "";
  const hueMarker = element(document, "span", "cp-hue-marker");
  hue.appendChild(hueStrip);
  hue.appendChild(hueMarker);
  palette.appendChild(sv);
  palette.appendChild(hue);

  const controls = element(document, "div", "cp-controls");
  const previews = element(document, "div", "cp-previews");
  const newPreview = element(document, "div", "cp-preview");
  const newLabel = element(document, "div", "cp-preview-label", "新的");
  const newSwatch = element(document, "div", "cp-swatch cp-swatch-new");
  newSwatch.id = prefix + "new-preview";
  newSwatch.setAttribute("aria-label", "新颜色预览");
  newPreview.appendChild(newLabel);
  newPreview.appendChild(newSwatch);
  const currentPreview = element(document, "div", "cp-preview");
  const currentLabel = element(document, "div", "cp-preview-label", "当前");
  const currentSwatch = element(document, "div", "cp-swatch cp-swatch-current");
  currentSwatch.id = prefix + "current-preview";
  currentSwatch.setAttribute("aria-label", "当前颜色");
  currentPreview.appendChild(currentLabel);
  currentPreview.appendChild(currentSwatch);
  previews.appendChild(newPreview);
  previews.appendChild(currentPreview);
  controls.appendChild(previews);

  const fields = {};
  const makeRow = (className, values) => {
    const row = element(document, "div", "cp-channel-row " + className);
    for (const definition of values) {
      fields[definition[0]] = makeField(document, prefix, definition[0], definition[1], definition[2]);
      row.appendChild(fields[definition[0]].parentNode.parentNode);
    }
    return row;
  };
  const hsvRow = makeRow("cp-hsv-row", [["h", "H (°)"], ["s", "S (%)"], ["v", "B (%)"]]);
  const rgbRow = makeRow("cp-rgb-row", [["r", "R"], ["g", "G"], ["b", "B"]]);
  const hexRow = element(document, "div", "cp-hex-row");
  fields.hex = makeField(document, prefix, "hex", "HEX");
  hexRow.appendChild(fields.hex.parentNode.parentNode);
  controls.appendChild(hsvRow);
  controls.appendChild(rgbRow);
  controls.appendChild(hexRow);
  main.appendChild(palette);
  main.appendChild(controls);

  const actions = element(document, "div", "cp-actions");
  const cancelButton = element(document, "sp-button", "cp-button cp-cancel");
  cancelButton.id = prefix + "cancel";
  cancelButton.setAttribute("variant", "secondary");
  const cancelLabel = element(document, "span", "", "取消");
  cancelButton.appendChild(cancelLabel);
  const confirmButton = element(document, "sp-button", "cp-button cp-confirm");
  confirmButton.id = prefix + "confirm";
  confirmButton.setAttribute("variant", "cta");
  const confirmLabel = element(document, "span", "", "确定");
  confirmButton.appendChild(confirmLabel);
  actions.appendChild(cancelButton);
  actions.appendChild(confirmButton);

  shell.appendChild(title);
  shell.appendChild(main);
  shell.appendChild(actions);
  dialog.appendChild(shell);
  document.body.appendChild(dialog);

  function listen(target, type, handler) {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  function removeListeners() {
    while (listeners.length) {
      const entry = listeners.pop();
      entry[0].removeEventListener(entry[1], entry[2]);
    }
  }

  function cleanup() {
    if (settled) return;
    settled = true;
    dragging = "";
    removeListeners();
    if (dialog.open && typeof dialog.close === "function") dialog.close();
    if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
  }

  function finish(result) {
    if (settled) return;
    cleanup();
    resolvePromise(result ? { r: rgb.r, g: rgb.g, b: rgb.b } : null);
  }

  function failToOpen(error) {
    if (settled) return;
    cleanup();
    rejectPromise(error);
  }

  function render() {
    const hueColor = hsvToRgb({ h: hsv.h, s: 100, v: 100 });
    sv.style.backgroundColor = cssColor(hueColor);
    svMarker.style.left = hsv.s + "%";
    svMarker.style.top = (100 - hsv.v) + "%";
    hueMarker.style.top = (hsv.h / 360 * 100) + "%";
    newSwatch.style.backgroundColor = cssColor(rgb);
    currentSwatch.style.backgroundColor = cssColor(initial);

    fields.h.value = displayDecimal(hsv.h);
    fields.s.value = displayDecimal(hsv.s);
    fields.v.value = displayDecimal(hsv.v);
    fields.r.value = String(rgb.r);
    fields.g.value = String(rgb.g);
    fields.b.value = String(rgb.b);
    fields.hex.value = rgbToHex(rgb);
    sv.setAttribute("aria-valuetext", "S " + displayDecimal(hsv.s) + "%，B " + displayDecimal(hsv.v) + "%");
    hue.setAttribute("aria-valuenow", displayDecimal(hsv.h));
  }

  function updateFromHsv(nextHsv) {
    hsv = {
      h: ((bounded(nextHsv.h, 0, 360) % 360) + 360) % 360,
      s: bounded(nextHsv.s, 0, 100),
      v: bounded(nextHsv.v, 0, 100)
    };
    rgb = hsvToRgb(hsv);
    render();
  }

  function updateFromRgb(nextRgb) {
    rgb = normalizeRgb(nextRgb);
    hsv = rgbToHsv(rgb);
    render();
  }

  function pointOn(elementNode, event) {
    const rect = elementNode.getBoundingClientRect();
    const width = rect.width || elementNode.clientWidth || 1;
    const height = rect.height || elementNode.clientHeight || 1;
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / width));
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / height));
    return { x: x, y: y };
  }

  function applyPointer(type, event) {
    const point = pointOn(type === "sv" ? sv : hue, event);
    if (type === "sv") {
      updateFromHsv({ h: hsv.h, s: point.x * 100, v: (1 - point.y) * 100 });
    } else {
      updateFromHsv({ h: point.y * 360, s: hsv.s, v: hsv.v });
    }
  }

  function stopDragging() {
    if (!dragging) return;
    dragging = "";
    const entries = [];
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i][0] === document && (listeners[i][1] === "mousemove" || listeners[i][1] === "mouseup")) {
        entries.push(listeners[i]);
        listeners.splice(i, 1);
      }
    }
    for (const entry of entries) document.removeEventListener(entry[1], entry[2]);
  }

  function startDragging(type, event) {
    if (event.button != null && event.button !== 0) return;
    if (typeof event.preventDefault === "function") event.preventDefault();
    dragging = type;
    applyPointer(type, event);
    if (listeners.some(entry => entry[0] === document && entry[1] === "mousemove")) return;
    listen(document, "mousemove", onDocumentMouseMove);
    listen(document, "mouseup", stopDragging);
  }

  function onDocumentMouseMove(event) {
    if (dragging) applyPointer(dragging, event);
  }

  function changeNumber(key, preserveInput) {
    const raw = String(fields[key].value == null ? "" : fields[key].value).trim();
    if (!raw || !Number.isFinite(Number(raw))) return;
    const value = Number(raw);
    if (key === "h" || key === "s" || key === "v") {
      const next = { h: hsv.h, s: hsv.s, v: hsv.v };
      const max = key === "h" ? 360 : 100;
      next[key] = bounded(value, 0, max);
      updateFromHsv(next);
      if (preserveInput && value >= 0 && value <= max) fields[key].value = raw;
      return;
    }
    const nextRgb = { r: rgb.r, g: rgb.g, b: rgb.b };
    nextRgb[key] = value;
    updateFromRgb(nextRgb);
    if (preserveInput && value >= 0 && value <= 255) fields[key].value = raw;
  }

  for (const key of ["h", "s", "v", "r", "g", "b"]) {
    const inputHandler = function () { changeNumber(key, true); };
    const changeHandler = function () {
      const raw = String(fields[key].value == null ? "" : fields[key].value).trim();
      if (!raw || !Number.isFinite(Number(raw))) render();
      else changeNumber(key, false);
    };
    listen(fields[key], "input", inputHandler);
    listen(fields[key], "change", changeHandler);
  }

  const onHexInput = function () {
    const color = hexToRgb(fields.hex.value);
    if (color) updateFromRgb(color);
  };
  const onHexChange = function () {
    if (!hexToRgb(fields.hex.value)) render();
    else onHexInput();
  };
  listen(fields.hex, "input", onHexInput);
  listen(fields.hex, "change", onHexChange);
  listen(sv, "mousedown", function (event) { startDragging("sv", event); });
  listen(hue, "mousedown", function (event) { startDragging("hue", event); });
  listen(sv, "keydown", function (event) {
    const step = event.shiftKey ? 10 : 1;
    const next = { h: hsv.h, s: hsv.s, v: hsv.v };
    if (event.key === "ArrowLeft") next.s -= step;
    else if (event.key === "ArrowRight") next.s += step;
    else if (event.key === "ArrowUp") next.v += step;
    else if (event.key === "ArrowDown") next.v -= step;
    else return;
    event.preventDefault();
    updateFromHsv(next);
  });
  listen(hue, "keydown", function (event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    updateFromHsv({ h: hsv.h + (event.key === "ArrowUp" ? -step : step), s: hsv.s, v: hsv.v });
  });
  listen(cancelButton, "click", function () { finish(null); });
  listen(confirmButton, "click", function () { finish(rgb); });
  listen(dialog, "keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(null);
    }
  });
  listen(dialog, "cancel", function (event) {
    event.preventDefault();
    finish(null);
  });
  listen(dialog, "close", function () { finish(null); });

  render();

  let resolvePromise;
  let rejectPromise;
  const result = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  try {
    const hostModal = dialog.showModal({ lockDocumentFocus: true });
    const openedAtReturn = dialog.open === true;
    if (hostModal && typeof hostModal.then === "function") {
      Promise.resolve(hostModal).then(function () {
        // UXP resolves the showModal promise when the host modal closes. If no
        // button already settled the picker, treat that close as cancellation.
        finish(null);
      }, function (error) {
        // A rejected promise after the modal opened represents a host dismissal
        // (for example Escape or the window close control). A rejection before
        // it opened is a real opening failure and must reach the caller.
        if (openedAtReturn) finish(null);
        else failToOpen(error);
      });
    }
  } catch (error) {
    failToOpen(error);
  }
  return result;
}

module.exports = { pickColor, rgbToHex, hexToRgb, rgbToHsv, hsvToRgb };
