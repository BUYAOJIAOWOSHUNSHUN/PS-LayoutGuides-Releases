"use strict";

// Action Manager numeric ruler origins are 16.16 fixed-point pixel offsets.
// Do not use bit shifts: they truncate fractional pixels and signed values.
// See docs/API-NOTES.md for evidence and the required Photoshop acceptance test.
function originPixels(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value / 65536;
  if (value && value._unit === "pixelsUnit" && Number.isFinite(value._value)) return value._value;
  throw new Error("无法识别标尺原点格式，已停止操作以避免辅助线偏移。");
}

function relativeCoordinate(target, origin) {
  return target.coordinate - (target.direction === "vertical" ? origin.x : origin.y);
}

module.exports = { originPixels, relativeCoordinate };
