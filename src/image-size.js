"use strict";

function unitToPixels(value, unit, ppi) {
  if (unit === "px") return value;
  if (unit === "in") return value * ppi;
  if (unit === "cm") return value * ppi / 2.54;
  if (unit === "mm") return value * ppi / 25.4;
  if (unit === "pt") return value * ppi / 72;
  return value * ppi / 6;
}

function pixelsToUnit(px, unit, ppi) {
  if (unit === "px") return px;
  if (unit === "in") return px / ppi;
  if (unit === "cm") return px * 2.54 / ppi;
  if (unit === "mm") return px * 25.4 / ppi;
  if (unit === "pt") return px * 72 / ppi;
  return px * 6 / ppi;
}

function formatUnitValue(px, unit, ppi) {
  const value = pixelsToUnit(px, unit, ppi);
  return unit === "px" ? String(Math.round(value)) : String(Number(value.toFixed(2)));
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 预览、宽高联动和提交使用同一组目标像素，避免显示与实际修改不一致。
function imageTarget(input, original) {
  if (!original) return null;
  const resolution = positive(input.resolution);
  const width = positive(input.width), height = positive(input.height);
  if (!resolution || (!input.locked && (!width || !height))) return null;
  if (input.locked && !(input.lastEdited === "imageHeight" ? height : width)) return null;
  const toPixels = (value, pixels) => resolution === original.resolution &&
    value === Number(formatUnitValue(pixels, input.unit, resolution))
    ? pixels : Math.round(unitToPixels(value, input.unit, resolution));
  let widthPx = toPixels(width, original.width);
  let heightPx = toPixels(height, original.height);
  if (input.locked) {
    const ratio = original.width / original.height;
    if (!Number.isFinite(ratio) || ratio <= 0) return null;
    if (input.lastEdited === "imageHeight") widthPx = Math.max(1, Math.round(heightPx * ratio));
    else heightPx = Math.max(1, Math.round(widthPx / ratio));
  }
  if (![widthPx, heightPx].every(n => Number.isFinite(n) && n >= 1 && n <= 300000)) return null;
  return { width: widthPx, height: heightPx, resolution };
}

function imageBytes(width, height, mode, bits) {
  const channels = { RGB: 3, CMYK: 4, GRAY: 1, LAB: 3 }[mode];
  if (!channels || ![8, 16, 32].includes(bits) || !positive(width) || !positive(height)) return null;
  return width * height * channels * bits / 8;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "K", "M", "G", "T"];
  let amount = bytes, index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
  return String(Number(amount.toPrecision(3))) + units[index];
}

module.exports = { unitToPixels, pixelsToUnit, formatUnitValue, imageTarget, imageBytes, formatBytes };
