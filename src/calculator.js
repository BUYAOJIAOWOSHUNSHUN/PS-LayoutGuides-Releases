"use strict";

const MM_PER_INCH = 25.4;

function calculateLayout(width, height, brand) {
  if (![width, height].every(n => typeof n === "number" && Number.isFinite(n) && n > 0)) {
    throw new Error("文档宽高必须是大于 0 的有限像素值。");
  }
  if (!brand || !Array.isArray(brand.logoRules)) {
    throw new Error("品牌标准数据不完整。");
  }
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  const ratio = longSide / shortSide;
  const orientation = width === height ? "square" : width > height ? "landscape" : "portrait";
  const marginX = shortSide / (brand.marginDivisor || 20);
  const logoPercent = pickLogoPercent(brand, ratio, orientation);
  const logoHeight = shortSide * logoPercent;
  const logoSafeFactor = Number.isFinite(brand.logoSafeFactor) ? brand.logoSafeFactor : 0.5;
  const endorsementFactor = Number.isFinite(brand.endorsementFactor) ? brand.endorsementFactor : 0.3;
  const endorsementMaxFactor = Number.isFinite(brand.endorsementMaxFactor) ? brand.endorsementMaxFactor : 0.8;
  return {
    width, height, orientation, shortSide, longSide, ratio, marginX,
    safeWidth: width - 2 * marginX, safeHeight: height - 2 * marginX,
    logoHeight, logoPercent, logoXMultiple: logoHeight / marginX,
    logoSafeInset: logoHeight * logoSafeFactor,
    endorsementHeight: logoHeight * endorsementFactor,
    endorsementMaxHeight: logoHeight * endorsementMaxFactor
  };
}

// 取第一条命中的比例规则；同一条规则可分别给横版 / 竖版的值。
function pickLogoPercent(brand, ratio, orientation) {
  for (const rule of brand.logoRules) {
    if (!(ratio <= rule.maxRatio)) continue;
    if (typeof rule.percent === "number") return rule.percent;
    const fallback = orientation === "landscape" ? rule.landscape : rule.portrait;
    if (typeof fallback === "number") return fallback;
  }
  throw new Error("品牌标准未覆盖当前画布比例，已停止计算。");
}

// 版心线：画布内缩版心边距的 4 条线。
function guideTargets(layout) {
  return [
    { direction: "vertical", coordinate: layout.marginX },
    { direction: "vertical", coordinate: layout.width - layout.marginX },
    { direction: "horizontal", coordinate: layout.marginX },
    { direction: "horizontal", coordinate: layout.height - layout.marginX }
  ];
}

// 出血线：画布外扩出血值的 4 条线（上下左右可各自不同）。
function bleedTargets(layout, bleedPx) {
  return [
    { direction: "vertical", coordinate: -bleedPx.left },
    { direction: "vertical", coordinate: layout.width + bleedPx.right },
    { direction: "horizontal", coordinate: -bleedPx.top },
    { direction: "horizontal", coordinate: layout.height + bleedPx.bottom }
  ];
}

// 毫米按文档实际分辨率换算成像素。
function millimetresToPixels(mm, resolution) {
  if (!Number.isFinite(mm) || mm < 0) throw new Error("出血值必须是不小于 0 的数字。");
  if (!Number.isFinite(resolution) || resolution <= 0) throw new Error("无法读取文档分辨率，已停止换算。");
  return mm * resolution / MM_PER_INCH;
}

function pixelsToMillimetres(px, resolution) {
  if (!Number.isFinite(resolution) || resolution <= 0) return NaN;
  return px * MM_PER_INCH / resolution;
}

module.exports = {
  calculateLayout, guideTargets, bleedTargets,
  millimetresToPixels, pixelsToMillimetres, MM_PER_INCH
};
