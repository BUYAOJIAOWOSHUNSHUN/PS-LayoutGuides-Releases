"use strict";

const ps = require("photoshop");
const { entrypoints, shell } = require("uxp");
const { createPhotoshopHost } = require("./photoshop-host.js");
const { GuideService, errorText } = require("./guide-service.js");
const { BRANDS, findBrand } = require("./brands.js");
const update = require("./update-service.js");
const { REPO, SUBDIR, REF_OVERRIDE, VERSION } = require("./update-config.js");

const host = createPhotoshopHost(ps);
const service = new GuideService(host);

const BLEED_FIELDS = ["top", "bottom", "left", "right"];
const BLEED_LABELS = { top: "上", bottom: "下", left: "左", right: "右" };
const MODE_BUTTONS = ["update", "logo", "endorsement", "bleed"];
// 三种生成按钮位于页签内容之外，两页真正共用，避免尺寸与事件不同步。
const ALL_BUTTONS = MODE_BUTTONS.concat(["clear", "visibility", "applyImageSize", "applyCanvasSize", "restoreImageSize", "restoreCanvasSize", "modeRGB", "modeCMYK"]);

let currentTab = "screen";
let bleedLocked = true;         // 出血四边默认锁定（老大要求）
let bleedUnit = "mm";
let imageLock = true;           // 图片大小的「锁定宽高比」
let canvasAnchor = "center";    // 画布大小的锚点（9 选 1）
let aspectRatio = 1;            // 当前文档的宽高比，用于锁定时换算
let visibilityReading = false;
let timer = null;
let initialized = false;
let lastSignature = null;
let lastResolution = null;
let lastDocWidth = null;    // 文档当前像素尺寸缓存，给「还原」按钮用
let lastDocHeight = null;
let pendingUpdate = null;
let registered = false;

// 9 格锚点的标识顺序，与 PS 的「画布大小」对话框一致：左上→右下。
// 下标即布局：row * 3 + col。
const ANCHOR_IDS = [
  "topLeft", "topCenter", "topRight",
  "middleLeft", "center", "middleRight",
  "bottomLeft", "bottomCenter", "bottomRight"
];

const el = id => document.getElementById(id);
const format = n => Number(n.toFixed(4)).toString();
const px = n => format(n) + " px";

// UXP 的 DOM 是自研实现，HTMLCollection / NodeList 不保证可迭代，
// 所以统一用下标遍历，不依赖 for...of、Array.from 或 innerHTML。
function childElements(element) {
  const result = [];
  for (let i = 0; i < element.childNodes.length; i++) {
    const node = element.childNodes[i];
    if (node.nodeType === 1) result.push(node);
  }
  return result;
}

function clearChildren(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

// 自绘小控件支持鼠标和键盘；Spectrum 按钮仍使用原生行为。
function bindAction(element, action) {
  element.addEventListener("click", action);
  element.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  });
}

// 同步禁用状态：属性也要跟着改，否则初始的 disabled 属性会一直留着，
// 按钮看着还是灰的（UXP 的 sp-button 是否把 .disabled 反射成属性并不保证）。
function setDisabled(id, disabled) {
  const element = el(id);
  element.disabled = disabled;
  if (disabled) element.setAttribute("disabled", "");
  else element.removeAttribute("disabled");
}

/* ---------- 数值输入框：真输入控件 sp-textfield（v1.9.6 起） ---------- */
// 之前是自绘 span（自带模拟光标、逐字符选区），但 UXP 会把面板里自绘控件收到的
// 按键**透传给 Photoshop 本体** —— 真机实测：在数值框打数字，图层面板的
// 「不透明度」被当成快捷输入跟着变。preventDefault 挡不住这层透传。
// 改用真输入控件后：聚焦期间宿主不再接收按键（官方内置插件同款行为），
// 光标、拖拽选区也都是原生的。代价是控件内部底色为组件写死的深灰（功能优先）。
// 读写统一走 readXxx/writeXxx；「确认修改」提交、失焦提交等语义不变。

function disableAll(disabled) {
  for (const id of ALL_BUTTONS) setDisabled(id, disabled);
}

function status(message, error) {
  el("status").textContent = message;
  el("status").className = error ? "error" : "";
}

/* ---------- 品牌标准 ---------- */

function buildBrandRow() {
  const row = el("brandRow");
  clearChildren(row);
  for (const brand of BRANDS) {
    const button = document.createElement("div");
    button.setAttribute("data-brand", brand.id);
    const mark = document.createElement("img");
    mark.className = "brand-mark";
    mark.src = brand.logo;
    mark.alt = brand.name;
    // 各品牌图形的显示尺寸写在 brands.js。显式给宽高，
    // 免得图片还没解码时 auto 宽度塌成 0，把文字顶到最左边。
    if (brand.logoWidth) mark.style.width = brand.logoWidth + "px";
    if (brand.logoHeight) mark.style.height = brand.logoHeight + "px";
    const name = document.createElement("span");
    name.className = "brand-name";
    name.textContent = brand.shortName || brand.name;
    button.appendChild(mark);
    button.appendChild(name);
    button.setAttribute("role", "button");
    button.setAttribute("tabindex", "0");
    button.title = brand.available ? brand.name : brand.name + " · 标准待录入";
    bindAction(button, () => selectBrand(brand.id));
    row.appendChild(button);
  }
  renderBrandRow();
}

function renderBrandRow() {
  const buttons = childElements(el("brandRow"));
  for (const button of buttons) {
    const id = button.getAttribute("data-brand");
    const brand = findBrand(id);
    button.className = "brand-button"
      + (id === service.brandId ? " active" : "")
      + (brand.available ? "" : " unavailable");
  }
}

function selectBrand(id) {
  const brand = findBrand(id);
  if (!brand.available) { status("「" + brand.name + "」的品牌标准还没录入。", true); return; }
  if (!service.setBrand(id)) return;
  renderBrandRow();
  renderBleedInputs();
  lastSignature = null;
  refresh(true);
  status("已切换到「" + brand.name + "」。已有辅助线需要重新生成才会套用新标准。");
}

/* ---------- 页签 ---------- */

function setTab(name) {
  currentTab = name;
  el("pageScreen").className = name === "screen" ? "page" : "page hidden";
  el("pagePrint").className = name === "print" ? "page" : "page hidden";
  el("tabScreen").className = name === "screen" ? "tab active" : "tab";
  el("tabPrint").className = name === "print" ? "tab active" : "tab";
  el("tabScreen").setAttribute("aria-selected", String(name === "screen"));
  el("tabPrint").setAttribute("aria-selected", String(name === "print"));
  refresh(false);
}

/* ---------- 出血值 ---------- */

// 内部一律用毫米存储，界面上按当前单位换算显示。
function trim(value) {
  return Number(value.toFixed(2)).toString();
}

function toDisplay(mm) {
  return bleedUnit === "mm" ? mm : mm / 10;
}

function fromDisplay(value) {
  return bleedUnit === "mm" ? value : value * 10;
}

/* ---------- 出血数值输入（真输入控件 sp-textfield） ---------- */

// 编辑语义：输入框就是唯一事实（原生编辑），失焦/回车时读框内值校验提交，
// Esc 把显示恢复成已提交值。编辑中的旧 editing[] 临时串机制随之删除。
const editing = {};

function readBleedValue(field) {
  return String(el("bleed-" + field).value || "").trim();
}

function writeBleedValue(field, text) {
  el("bleed-" + field).value = String(text);
  editing[field] = null;
}

// 键盘过滤：只放行数字、小数点和导航键，其余一律吞掉——
// 一方面保证框里永远是合法数字，另一方面（真输入框聚焦时宿主本来就不收按键）
// 双保险防止误触 PS 快捷键。
function onBleedKeydown(field, event) {
  const key = event.key;
  if (key === "ArrowUp" || key === "ArrowDown") {
    event.preventDefault();
    stepBleed(field, key === "ArrowUp" ? 1 : -1);
    return;
  }
  if (key === "Enter") { event.preventDefault(); commitBleedEdit(field); return; }
  if (key === "Escape") {
    event.preventDefault();
    editing[field] = null;
    renderBleedInputs();
    updateBleedPreview();
    return;
  }
  if (key.length === 1 && !/[0-9.]/.test(key)) event.preventDefault();
}

// 把框内当前值提交给 service。空串按 0 处理，不让用户卡在错误态。
function commitBleedEdit(field) {
  const raw = readBleedValue(field);
  onBleedInput(field, raw === "" ? "0" : raw);
}

function renderBleedInputs() {
  for (const field of BLEED_FIELDS) {
    writeBleedValue(field, trim(toDisplay(service.bleedMM[field])));
    el("unit-" + field).textContent = bleedUnit;
  }
  renderLockState();
}

function renderLockState() {
  el("lock").className = bleedLocked ? "lock-button locked" : "lock-button unlocked";
  // 图标显示的是「当前状态」：锁定 = 闭合锁，解锁 = 开口锁（各一张 PNG）。
  el("lockIcon").src = bleedLocked ? "assets/icon-lock.png" : "assets/icon-unlock.png";
  const label = bleedLocked ? "解锁四边，分别设置" : "锁定四边同步";
  el("lock").title = label;
  el("lock").setAttribute("aria-label", label);
  el("lock").setAttribute("aria-pressed", String(bleedLocked));
  for (const field of BLEED_FIELDS) {
    for (const direction of ["up", "down"]) {
      const text = BLEED_LABELS[field] + "出血" + (direction === "up" ? "增加" : "减少") + " 1 " + bleedUnit;
      el("step-" + direction + "-" + field).title = text;
      el("step-" + direction + "-" + field).setAttribute("aria-label", text);
    }
  }
}

function stepBleed(field, delta) {
  const raw = readBleedValue(field).trim();
  const parsed = Number(raw);
  const value = raw && Number.isFinite(parsed) && parsed >= 0 ? parsed : toDisplay(service.bleedMM[field]);
  // 每次增减当前显示单位的 1；允许手填小数，最小为 0。
  onBleedInput(field, trim(Math.max(0, value + delta)));
}

function setUnit(unit) {
  if (unit === bleedUnit) return;
  bleedUnit = unit;
  el("unitMM").className = unit === "mm" ? "unit-option active" : "unit-option";
  el("unitCM").className = unit === "cm" ? "unit-option active" : "unit-option";
  renderBleedInputs();
  updateBleedPreview();
  status("单位已切换为 " + unit + "。");
}

// 清零按钮：四个出血值全部归 0，只改数值，不动已生成的辅助线。
function resetBleed() {
  service.setBleed({ top: 0, bottom: 0, left: 0, right: 0 });
  renderBleedInputs();
  updateBleedPreview();
  status("出血值已全部清零。");
}

function toggleLock() {
  bleedLocked = !bleedLocked;
  if (bleedLocked) {
    // 锁定时以「上」为准，把其余三边统一，避免出现锁定后仍不一致的中间状态。
    const value = service.bleedMM.top;
    service.setBleed({ top: value, bottom: value, left: value, right: value });
    renderBleedInputs();
    updateBleedPreview();
    status("已锁定：改任意一边，其余三边同步。");
  } else {
    renderLockState();
    status("已解锁：上下左右可以分别填写。");
  }
}

function onBleedInput(field, raw) {
  const display = Number(String(raw).trim());
  if (!String(raw).trim() || !Number.isFinite(display) || display < 0) {
    renderBleedInputs();
    status("出血值必须是不小于 0 的数字。", true);
    return;
  }
  const mm = fromDisplay(display);
  if (bleedLocked) {
    service.setBleed({ top: mm, bottom: mm, left: mm, right: mm });
    renderBleedInputs();
  } else {
    service.setBleed({ [field]: mm });
    writeBleedValue(field, trim(display));
  }
  updateBleedPreview();
}

function updateBleedPreview() {
  const values = service.bleedMM;
  const summary = BLEED_FIELDS.map(field => BLEED_LABELS[field] + " " + trim(toDisplay(values[field]))).join(" / ");
  el("bleedPreview").textContent = summary + " " + bleedUnit
    + (Number.isFinite(lastResolution) ? " · " + format(lastResolution) + " PPI" : " · 自画布边缘向内缩");
}

/* ---------- 文档信息 ---------- */

function refresh(explicit) {
  if (service.busy) return;
  try {
    const snapshot = service.snapshot();
    const signature = JSON.stringify(snapshot);
    const changed = signature !== lastSignature;
    lastSignature = snapshot ? signature : null;
    disableAll(!snapshot);
    setDisabled("clear", !snapshot || !(snapshot.ownedCount + snapshot.otherCount));
    if (!snapshot) {
      lastResolution = null;
      lastDocWidth = null;
      lastDocHeight = null;
      aspectRatio = 1;
      renderDocMode("");
      el("documentName").textContent = "请打开 Photoshop 文档";
      el("dimensions").textContent = "以整个文档画布为基准";
      el("bleedGuideState").textContent = "尚未创建";
      writeSizeValue("imageWidth", "0");
      writeSizeValue("imageHeight", "0");
      writeSizeValue("imageResolution", "0");
      writeSizeValue("canvasWidth", "0");
      writeSizeValue("canvasHeight", "0");
      updateBleedPreview();
      renderExtSwatch();   // 选着前景/背景时文档没了，色块退占位色
      if (changed || explicit) status("当前没有打开的文档。");
      return;
    }
    const l = snapshot.layout;
    lastResolution = snapshot.resolution;
    lastDocWidth = l.width;
    lastDocHeight = l.height;
    aspectRatio = l.width / l.height || 1;
    el("documentName").textContent = snapshot.name;
    el("dimensions").textContent = px(l.width) + " × " + px(l.height) + " · " + format(snapshot.resolution) + " PPI · " + snapshot.mode;
    renderDocMode(snapshot.mode);
    // 文档变了（切换 / 撤销 / 确认修改成功）就以文档为准，清掉编辑标记；
    // 文档没变时，聚焦中或编辑过的框不能回写，否则用户输入会被冲掉。
    if (changed) {
      for (let i = 0; i < SIZE_FIELDS.length; i++) sizeDirty[SIZE_FIELDS[i]] = false;
      sizeLastEdited = null;   // 文档已变（撤销/修改成功），联动方向也作废
    }
    const keepUserInput = field => !changed && (sizeDirty[field] || sizeFocus === field);
    // 图片大小：宽/高按当前单位换算显示，分辨率固定 PPI。
    if (!keepUserInput("imageWidth")) writeSizeValue("imageWidth", formatUnitValue(l.width, imageUnit, snapshot.resolution));
    if (!keepUserInput("imageHeight")) writeSizeValue("imageHeight", formatUnitValue(l.height, imageUnit, snapshot.resolution));
    if (!keepUserInput("imageResolution")) writeSizeValue("imageResolution", Math.round(snapshot.resolution));
    // 画布大小：宽/高按当前单位换算显示。
    if (!keepUserInput("canvasWidth")) writeSizeValue("canvasWidth", formatUnitValue(l.width, canvasUnit, snapshot.resolution));
    if (!keepUserInput("canvasHeight")) writeSizeValue("canvasHeight", formatUnitValue(l.height, canvasUnit, snapshot.resolution));
    el("bleedGuideState").textContent = snapshot.bleedGuideCount ? "已创建 " + snapshot.bleedGuideCount + " 条" : "尚未创建";
    updateBleedPreview();
    renderExtSwatch();   // 前景/背景色变了色块跟着变（固定色写了也是同一个值，开销可忽略）
    if (changed || explicit) {
      status(snapshot.ownedCount ? "已就绪 · 当前文档已有 " + snapshot.ownedCount + " 条插件辅助线。" : "已就绪 · 可创建版心、LOGO 高度线或出血线。");
    }
    void syncVisibility(snapshot.id);
  } catch (error) {
    disableAll(true);
    status("读取失败：" + errorText(error), true);
  }
}

/* ---------- 图片大小 / 画布大小 编辑器 ---------- */

// 跟出血一样的「自绘数值框」套路：span + keydown + 自己接数字键盘事件。
// UXP 里除 sp-textfield 外没有可用的文本输入控件，所以这五个框（imageWidth / imageHeight /
// imageResolution / canvasWidth / canvasHeight）都是自绘的。
//
// 与出血的关键差异：**输入框不直接改状态**。这里只是让用户输入目标值，
// 点「确认修改」才真正调用 resizeImage / resizeCanvas。所以失焦/回车时不做合法性校验，
// 「确认修改」按钮统一收一遍。
const SIZE_FIELDS = ["imageWidth", "imageHeight", "imageResolution", "canvasWidth", "canvasHeight"];

/* 长度单位（模仿 PS 新建 / 画布大小对话框）：全部以英寸为桥互相换算。
   1 点 = 1/72 英寸，1 派卡 = 12 点 = 1/6 英寸。像素单位不随分辨率缩放。 */
const UNIT_NAMES = { px: "像素", in: "英寸", cm: "厘米", mm: "毫米", pt: "点", pc: "派卡" };
let imageUnit = "px";   // 图片大小卡的单位（宽度/高度两行共用）
let canvasUnit = "cm";  // 画布大小卡的单位

/* ---------- 画布扩展颜色（v1.9.9，模仿 PS「画布大小」对话框） ---------- */
// 选项顺序与 PS 对话框一致：前景 / 背景 / 白色 / 黑色 / 灰色 / 其它。
// 「其它」走 PS 自带拾色器（v1.9.11）：点色块或选「其它」都会弹窗，
// 选中的颜色记进 canvasCustomColor，选项自动停在「其它」上。
// 前景/背景在点「确认修改」时现场读文档的 FG/BG（随用随取，不缓存）；
// 读不到时退回白色并在状态栏说明。扩展颜色只影响**新增**的画布区域
// （且只对有背景层的文档生效，这是 PS 本身的行为），缩小画布时用不到它。
const EXT_OPTIONS = ["foreground", "background", "white", "black", "gray", "other"];
const EXT_COLOR_NAMES = { foreground: "前景", background: "背景", white: "白色", black: "黑色", gray: "灰色", other: "其它" };
const EXT_COLOR_FIXED = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  gray: { r: 128, g: 128, b: 128 }
};
let canvasExtension = "white";   // 默认白色（PS 对话框的默认值）
let canvasCustomColor = null;    // 「其它」的自定颜色（拾色器选出来的 RGB）
let extPickerApi = null;         // 扩展颜色下拉的 set 接口（buildOptionPicker 返回）

// 当前扩展颜色的「有效 RGB」：固定色直接给；前景/背景读文档；其它读自定色。
function effectiveExtColor() {
  if (canvasExtension === "white") return EXT_COLOR_FIXED.white;
  if (canvasExtension === "black") return EXT_COLOR_FIXED.black;
  if (canvasExtension === "gray") return EXT_COLOR_FIXED.gray;
  if (canvasExtension === "foreground") return host.getForegroundRGB() || EXT_COLOR_FIXED.white;
  if (canvasExtension === "background") return host.getBackgroundRGB() || EXT_COLOR_FIXED.white;
  return canvasCustomColor || EXT_COLOR_FIXED.white;
}

// 色块：固定色直接上色；前景/背景跟随文档当前的 FG/BG，其它跟随自定色，每次 refresh 顺带刷新。
function renderExtSwatch() {
  const swatch = el("canvasExtSwatch");
  const rgb = effectiveExtColor();
  swatch.style.backgroundColor = rgb ? "rgb(" + rgb.r + "," + rgb.g + "," + rgb.b + ")" : "#6f6f6f";
}

// 面板内迷你取色器（v1.9.13）：PS 原生拾色器在 UXP 里调不出来
//（v1.9.11 借道「设置前景色」被拒、v1.9.12 四种组合探测全灭），改成面板内置：
// 点色块弹出「预设色板（16 色）+ 十六进制输入」小面板，选完即应用。
const EXT_PRESETS = [
  "FFFFFF", "000000", "F2F2F2", "D9D9D9", "A6A6A6", "595959", "404040", "808080",
  "FF0000", "FF8000", "FFE000", "00B050", "00B0F0", "0070C0", "7030A0", "FF00FF"
];
let extPopup = null;
let extHue = 0;              // 取色器当前色相（0-359）
let extSV = { s: 1, v: 1 };  // 取色器当前饱和度 / 明度
let extSvSquare = null;      // SV 方块元素（切色相时要更新渐变底色）
let extHexField = null;      // 十六进制输入框（SV/色相选色后要同步回它，v1.9.18）

function hexToRgb(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHex(rgb) {
  return ((1 << 24) + (rgb.r << 16) + (rgb.g << 8) + rgb.b).toString(16).slice(1).toUpperCase();
}

// HSV → RGB（h 0-359，s/v 0-1）。维基百科标准公式：f(n) = v − v·s·max(0, min(k, 4−k, 1))。
function hsvToRgb(h, s, v) {
  const f = n => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: Math.round(f(5) * 255), g: Math.round(f(3) * 255), b: Math.round(f(1) * 255) };
}

function rgbToHsv(rgb) {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  return { h: h, s: max === 0 ? 0 : d / max, v: max };
}

function closeExtPopup() {
  if (extPopup && extPopup.parentNode) extPopup.parentNode.removeChild(extPopup);
  extPopup = null;
  extSvSquare = null;
  extHexField = null;
}

function applyCustomExtColor(rgb, keepOpen) {
  canvasExtension = "other";
  canvasCustomColor = rgb;
  extPickerApi.set("other");
  renderExtSwatch();
  // 十六进制框实时跟随当前颜色（v1.9.18 修「点应用又变回白色」）：之前框里留的是
  // 打开面板时的旧值——比如先点过某个色板，之后 SV 区选的新颜色没同步进去，
  // 点「应用」就被旧值打回去了（老大诊断成「下面的色板干扰了上面的点选」）。
  if (extHexField) extHexField.value = "#" + rgbToHex(rgb);
  if (!keepOpen) closeExtPopup();
  status("画布扩展颜色：自定 #" + rgbToHex(rgb) + "。");
}

function toggleExtPopup() {
  if (extPopup) { closeExtPopup(); return; }
  const wrap = el("canvasExtSwatchWrap");
  extPopup = document.createElement("div");
  extPopup.className = "ext-popup";
  extPopup.addEventListener("click", event => event.stopPropagation());
  // 起点色相 / 饱和明度取自当前颜色，让选色面板开在当前颜色附近。
  const startHsv = rgbToHsv(effectiveExtColor());
  extHue = startHsv.h;
  extSV = { s: startHsv.s, v: startHsv.v };
  // ---- SV 选色区 + 色相条（模仿 PS 拾色器的选色布局，点一下即选；带位置标识）----
  const pickRow = document.createElement("div");
  pickRow.className = "ext-popup-row";
  const square = document.createElement("div");
  square.className = "ext-popup-sv";
  const squareFill = document.createElement("div");
  squareFill.className = "ext-popup-sv-fill";
  square.appendChild(squareFill);
  // 位置标识：白边方框小环，标出当前选中的饱和度 / 明度点（PS 同款形式）。
  const svMarker = document.createElement("div");
  svMarker.className = "ext-popup-sv-marker";
  square.appendChild(svMarker);
  extSvSquare = square;
  const placeSvMarker = () => {
    const rect = square.getBoundingClientRect();
    if (!rect.width) return;
    svMarker.style.left = Math.max(0, Math.min(rect.width - 12, extSV.s * (rect.width - 12))) + "px";
    svMarker.style.top = Math.max(0, Math.min(rect.height - 12, (1 - extSV.v) * (rect.height - 12))) + "px";
  };
  const updateSv = () => {
    square.style.background = "linear-gradient(to right, #ffffff, hsl(" + extHue + ", 100%, 50%))";
    placeSvMarker();
  };
  const pickSv = event => {
    const rect = square.getBoundingClientRect();
    const x = Number.isFinite(event.clientX) ? event.clientX - rect.left : event.offsetX;
    const y = Number.isFinite(event.clientY) ? event.clientY - rect.top : event.offsetY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    extSV = {
      s: Math.max(0, Math.min(1, x / Math.max(1, rect.width))),
      v: 1 - Math.max(0, Math.min(1, y / Math.max(1, rect.height)))
    };
    placeSvMarker();
    applyCustomExtColor(hsvToRgb(extHue, extSV.s, extSV.v), true);
  };
  square.addEventListener("click", event => { event.stopPropagation(); pickSv(event); });
  pickRow.appendChild(square);
  const hueBar = document.createElement("div");
  hueBar.className = "ext-popup-hue";
  // 色相位置标识：白色横杠，标出当前色相（PS 色相滑条的指针形式）。
  const hueMarker = document.createElement("div");
  hueMarker.className = "ext-popup-hue-marker";
  hueBar.appendChild(hueMarker);
  const placeHueMarker = () => {
    const rect = hueBar.getBoundingClientRect();
    if (!rect.width) return;
    hueMarker.style.top = Math.max(0, Math.min(rect.height - 4, extHue / 360 * (rect.height - 4))) + "px";
  };
  const pickHue = event => {
    const rect = hueBar.getBoundingClientRect();
    const y = Number.isFinite(event.clientY) ? event.clientY - rect.top : event.offsetY;
    if (!Number.isFinite(y)) return;
    extHue = Math.max(0, Math.min(359, Math.round(y / Math.max(1, rect.height) * 360)));
    placeHueMarker();
    updateSv();
    applyCustomExtColor(hsvToRgb(extHue, extSV.s, extSV.v), true);
  };
  hueBar.addEventListener("click", event => { event.stopPropagation(); pickHue(event); });
  pickRow.appendChild(hueBar);
  extPopup.appendChild(pickRow);
  // 预设色板：两行各 8 格，点一下立即应用。
  for (let row = 0; row < 2; row++) {
    const rowEl = document.createElement("div");
    rowEl.className = "ext-popup-row";
    for (let i = row * 8; i < row * 8 + 8 && i < EXT_PRESETS.length; i++) {
      const hex = EXT_PRESETS[i];
      const cell = document.createElement("span");
      cell.className = "ext-popup-swatch";
      cell.style.backgroundColor = "#" + hex;
      cell.setAttribute("role", "button");
      cell.setAttribute("tabindex", "0");
      cell.title = "#" + hex;
      cell.addEventListener("click", function (event) {
        event.stopPropagation();
        applyCustomExtColor(hexToRgb(hex));
      });
      rowEl.appendChild(cell);
    }
    extPopup.appendChild(rowEl);
  }
  // 十六进制输入行：sp-textfield（真输入控件）+ 应用按钮，回车同样生效。
  const hexRow = document.createElement("div");
  hexRow.className = "ext-popup-row";
  const field = document.createElement("sp-textfield");
  field.className = "ext-popup-input";
  field.setAttribute("aria-label", "十六进制颜色");
  const apply = document.createElement("sp-button");
  apply.setAttribute("variant", "cta");
  apply.className = "ext-popup-apply";
  const label = document.createElement("span");
  label.className = "button-label";
  label.textContent = "应用";
  apply.appendChild(label);
  const applyHex = function () {
    const rgb = hexToRgb(field.value);
    if (!rgb) { status("十六进制颜色格式不对，应为 #RRGGBB。", true); return; }
    applyCustomExtColor(rgb);
  };
  apply.addEventListener("click", function (event) { event.stopPropagation(); applyHex(); });
  field.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); applyHex(); }
    event.stopPropagation();
  });
  field.addEventListener("click", function (event) { event.stopPropagation(); });
  // 十六进制框也套浅灰衬底（v1.9.18，老大反馈小面板里的框还是黑底），
  // 与主面板数值框同一套 .field-wrap 方案，宽度 96px。
  const hexWrap = document.createElement("span");
  hexWrap.className = "field-wrap field-wrap-hex";
  hexWrap.appendChild(field);
  hexRow.appendChild(hexWrap);
  hexRow.appendChild(apply);
  extPopup.appendChild(hexRow);
  wrap.appendChild(extPopup);
  // append 之前量不到尺寸，位置标识要等挂上后再摆放。
  placeSvMarker();
  placeHueMarker();
  // 起始十六进制值在 append 之后再赋（预览的替身组件 append 时才升级，提前赋会被吞）。
  extHexField = field;
  const start = effectiveExtColor();
  field.value = start ? "#" + rgbToHex(start) : "#FFFFFF";
}

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

// 显示格式：像素取整，其它单位保留两位小数（和 PS 一致）。
function formatUnitValue(px, unit, ppi) {
  const v = pixelsToUnit(px, unit, ppi);
  return unit === "px" ? String(Math.round(v)) : String(Number(v.toFixed(2)));
}

/* ---------- 自绘单位下拉 ---------- */
// sp-picker 真机「菜单能弹但选项选不上」（事件行为不可控，返工两轮），弃用。
// 自绘和自绘数值框同一套路：容器 div（当前值 + 箭头）+ 点击弹出菜单 + 点选项回调。
const UNIT_OPTIONS = ["px", "in", "cm", "mm", "pt", "pc"];

function buildUnitPicker(pickerId, onChange) {
  buildOptionPicker(pickerId, UNIT_OPTIONS, unit => UNIT_NAMES[unit] || unit, onChange);
}

// 通用自绘下拉：单位下拉和画布扩展颜色下拉共用同一套结构（容器 + 标签 + 箭头 +
// 点击弹出菜单 + 点选项回调 + 点别处收起 + Enter/空格开合）。
// dividerBefore：哪些选项上边要加分割线（v1.9.16，对齐 PS 下拉的设计 ——
// 「其它」这类自定入口和固定项之间用横线隔开）。
function buildOptionPicker(pickerId, options, labelOf, onChange, dividerBefore) {
  const picker = el(pickerId);
  const label = document.createElement("span");
  label.className = "unit-label";
  const chevron = document.createElement("span");
  chevron.className = "unit-chevron";
  chevron.textContent = "▾";
  picker.appendChild(label);
  picker.appendChild(chevron);
  let menu = null;

  function render() {
    label.textContent = labelOf(picker.getAttribute("data-value"));
  }
  function close() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }
  function open() {
    close();
    menu = document.createElement("div");
    menu.className = "unit-menu";
    const current = picker.getAttribute("data-value");
    for (let i = 0; i < options.length; i++) {
      (function (option) {
        if (dividerBefore && dividerBefore.indexOf(option) >= 0) {
          const divider = document.createElement("div");
          divider.className = "unit-divider";
          menu.appendChild(divider);
        }
        const item = document.createElement("div");
        item.className = "unit-option-item";
        item.textContent = (option === current ? "✓ " : "") + labelOf(option);
        item.addEventListener("click", function (event) {
          event.stopPropagation();
          picker.setAttribute("data-value", option);
          render();
          close();
          onChange(option);
        });
        menu.appendChild(item);
      })(options[i]);
    }
    picker.appendChild(menu);
  }
  function toggle(event) {
    event.stopPropagation();
    if (menu) close();
    else open();
  }
  picker.addEventListener("click", toggle);
  picker.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(event); }
  });
  // 点面板其它地方收起菜单（UXP 支持 document 级监听）。
  document.addEventListener("click", function () { close(); });
  render();
  // 程序化改值（例如「其它」取消时回拨选项），标签同步重绘。
  return {
    set(value) {
      picker.setAttribute("data-value", value);
      render();
    }
  };
}

// 编辑保护：轮询 refresh() 每 1.2 秒跑一次，会把数值框重写成文档当前值。
// 真机上用户敲的数字就是这样被冲掉的（「输一个马上还原」就是它）。
// 规则：聚焦中的框不回写；用户编辑过（dirty）的框，在文档真的变化
// （撤销 / 确认修改成功，两种都会让快照签名变化）之前也不回写。
const sizeDirty = {};
let sizeFocus = null;
// 锁定比例时「以谁为准」：最后编辑的是宽还是高（v1.9.8 修复）。
// 之前永远保留宽、按比例重算高 —— 用户只改高度时会被拉回原比例，
// 请求尺寸 = 原尺寸，PS 无事可做，表现就是「点确认修改不动、数值弹回去」。
let sizeLastEdited = null;

function readSizeValue(field) {
  return String(el(field).value || "").trim();
}

function writeSizeValue(field, text) {
  el(field).value = String(text);
}

// 真输入框的原生编辑（光标/选区/退格都由控件自己处理），这里只做三件事：
// Enter = 提交并交还焦点；Esc = 放弃编辑用文档当前值还原；非法字符一律吞掉。
function onSizeKeydown(field, event) {
  const key = event.key;
  if (key === "Enter") { event.preventDefault(); el(field).blur(); return; }
  if (key === "Escape") {
    // Esc = 放弃这次编辑：清掉编辑标记、交还焦点，再让 refresh() 用文档当前值还原显示。
    event.preventDefault();
    sizeDirty[field] = false;
    if (sizeFocus === field) sizeFocus = null;
    el(field).blur();
    refresh(false);
    return;
  }
  if (key.length === 1 && !/[0-9.]/.test(key)) event.preventDefault();   // 只允许数字和小数点
}

// 锁链图标：切换锁定状态，并联动宽高输入框。
function renderImageLock() {
  const lock = el("imageLock");
  lock.className = imageLock ? "size-lock locked" : "size-lock";
  const label = imageLock ? "解锁宽高比" : "锁定宽高比";
  lock.setAttribute("aria-pressed", String(imageLock));
  lock.setAttribute("aria-label", label);
  lock.title = label;
}

function toggleImageLock() {
  imageLock = !imageLock;
  renderImageLock();
  status(imageLock ? "已锁定：改宽/高时另一边按当前比例自动调整。" : "已解锁：宽与高分别设置。");
}

// 9 格锚点：把格子画到 anchorGrid 里，每个 click / keydown 切换。
// 结构是 3 个 .anchor-row（横向 flex），每行 3 个 .anchor-cell ——
// 不能靠 display:grid 铺，UXP 真机不支持 CSS Grid（见 styles.css 里的说明）。
function buildAnchorGrid() {
  const grid = el("anchorGrid");
  while (grid.firstChild) grid.removeChild(grid.firstChild);
  for (let row = 0; row < 3; row++) {
    const rowEl = document.createElement("div");
    rowEl.className = "anchor-row";
    for (let col = 0; col < 3; col++) {
      const id = ANCHOR_IDS[row * 3 + col];
      const span = document.createElement("span");
      // 白色分割线：前两列画右边线、前两行画下边线（edge-r / edge-b），
      // 存在 data-edge 里，renderAnchor 重建 className 时不能丢。
      span.setAttribute("data-anchor", id);
      span.setAttribute("data-edge", (col < 2 ? "r" : "") + (row < 2 ? "b" : ""));
      span.setAttribute("role", "radio");
      span.setAttribute("tabindex", "0");
      span.title = ANCHOR_LABEL[id];
      span.setAttribute("aria-label", ANCHOR_LABEL[id]);
      span.addEventListener("click", () => selectAnchor(id));
      span.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectAnchor(id); }
      });
      rowEl.appendChild(span);
    }
    grid.appendChild(rowEl);
  }
  renderAnchor();
}

const ANCHOR_LABEL = {
  topLeft:      "左上",
  topCenter:    "上中",
  topRight:     "右上",
  middleLeft:   "左中",
  center:       "正中",
  middleRight:  "右中",
  bottomLeft:   "左下",
  bottomCenter: "下中",
  bottomRight:  "右下"
};

function renderAnchor() {
  // 格子现在包在 3 个 .anchor-row 里（UXP 不支持 CSS Grid，见 buildAnchorGrid）。
  // className 每次重建，白色分割线（edge-r / edge-b）从 data-edge 里带回来。
  const rows = el("anchorGrid").childNodes;
  for (let r = 0; r < rows.length; r++) {
    const rowEl = rows[r];
    if (!rowEl || rowEl.nodeType !== 1) continue;
    const cells = rowEl.childNodes;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell || cell.nodeType !== 1) continue;
      const id = cell.getAttribute("data-anchor");
      const edge = cell.getAttribute("data-edge") || "";
      cell.className = "anchor-cell"
        + (id === canvasAnchor ? " active" : "")
        + (edge.indexOf("r") >= 0 ? " edge-r" : "")
        + (edge.indexOf("b") >= 0 ? " edge-b" : "");
      cell.setAttribute("aria-checked", String(id === canvasAnchor));
    }
  }
}

function selectAnchor(id) {
  canvasAnchor = id;
  renderAnchor();
  status("画布锚点已选：" + ANCHOR_LABEL[id] + "。");
}

/* ---------- 执行（图片大小 / 画布大小） ---------- */

// UXP 的 sp-textfield 是黑盒组件：真机上 keydown 的 preventDefault **拦不住**
// 内部输入框（按键直达控件内部，字母照样进得来——真机实锤：画布宽度能打出 sdad）。
// 所以数字过滤改在 input 事件里做：把值洗一遍，只留数字和第一个小数点。
// 代价是洗完光标跳到末尾 —— 数值框可接受。
function sanitizeNumberText(raw) {
  let text = String(raw == null ? "" : raw).replace(/[^0-9.]/g, "");
  const first = text.indexOf(".");
  if (first >= 0) {
    text = text.slice(0, first + 1) + text.slice(first + 1).replace(/\./g, "");
  }
  return text;
}

// 把数字字符串解析为正数；解析失败返回 null。
function parsePositive(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

// UXP 的 AnchorPosition 枚举值：与 Photoshop 内部的锚点编号一致。
// 这里硬编码是为了少一次对 ps.constants 的引用 —— 启动时再核对一次。
const ANCHOR_POSITION = {
  topLeft: "TOPLEFT", topCenter: "TOPCENTER", topRight: "TOPRIGHT",
  middleLeft: "MIDDLELEFT", center: "MIDDLECENTER", middleRight: "MIDDLERIGHT",
  bottomLeft: "BOTTOMLEFT", bottomCenter: "BOTTOMCENTER", bottomRight: "BOTTOMRIGHT"
};

async function applyImageSize() {
  if (service.busy) return;
  const doc = host.active();
  if (!doc) { status("当前没有打开的文档。", true); return; }
  const widthValue = parsePositive(readSizeValue("imageWidth"));
  const heightValue = parsePositive(readSizeValue("imageHeight"));
  const resolution = parsePositive(readSizeValue("imageResolution"));
  if (widthValue == null || heightValue == null || resolution == null) {
    status("图片大小的宽、高、分辨率都必须是大于 0 的数字。", true);
    return;
  }
  // 输入值按当前单位换算成像素（宽/高共用一个单位下拉）。
  let widthPx = Math.round(unitToPixels(widthValue, imageUnit, resolution));
  let heightPx = Math.round(unitToPixels(heightValue, imageUnit, resolution));
  if (imageLock && aspectRatio > 0) {
    // 锁定比例 = 以**最后编辑的一边**为准联动另一边（和 PS 图像大小对话框一致）：
    // 改高 → 宽按比例走；改宽（或没动过）→ 高按比例走。
    if (sizeLastEdited === "imageHeight") {
      widthPx = Math.round(heightPx * aspectRatio);
      writeSizeValue("imageWidth", formatUnitValue(widthPx, imageUnit, resolution));
    } else {
      heightPx = Math.round(widthPx / aspectRatio);
      writeSizeValue("imageHeight", formatUnitValue(heightPx, imageUnit, resolution));
    }
  }
  disableAll(true);
  status("正在修改图片大小…");
  let failed = false;
  let message;
  try {
    await host.modal(() => host.resizeImage(doc, widthPx, heightPx, resolution), "修改图片大小");
    message = "图片大小已修改为 " + widthPx + " × " + heightPx + " 像素（按" + UNIT_NAMES[imageUnit] + "输入）· " + resolution + " PPI。";
  } catch (error) {
    console.error(error);
    message = "图片大小修改失败：" + errorText(error);
    failed = true;
  } finally {
    refresh(false);
    status(message, failed);
  }
}

async function applyCanvasSize() {
  if (service.busy) return;
  const doc = host.active();
  if (!doc) { status("当前没有打开的文档。", true); return; }
  // 画布宽高按当前单位输入，换算成像素再交给 resizeCanvas。
  // 文档的 PPI 来自上次 refresh() 写入的 lastResolution。
  if (!Number.isFinite(lastResolution) || lastResolution <= 0) {
    status("无法读取文档分辨率，画布大小修改中止。", true);
    return;
  }
  const widthValue = parsePositive(readSizeValue("canvasWidth"));
  const heightValue = parsePositive(readSizeValue("canvasHeight"));
  if (widthValue == null || heightValue == null) {
    status("画布大小的宽、高都必须是大于 0 的数字。", true);
    return;
  }
  const widthPx = Math.round(unitToPixels(widthValue, canvasUnit, lastResolution));
  const heightPx = Math.round(unitToPixels(heightValue, canvasUnit, lastResolution));
  // 扩展颜色：固定色直接用；前景/背景现场读文档 FG/BG，其它用拾色器选的自定色，
  // 都拿不到退白色并说明。
  let extensionColor = EXT_COLOR_FIXED[canvasExtension] || (canvasExtension === "other" ? canvasCustomColor : null);
  let extensionNote = "";
  if (!extensionColor && canvasExtension === "foreground") {
    extensionColor = host.getForegroundRGB();
    if (!extensionColor) { extensionColor = EXT_COLOR_FIXED.white; extensionNote = "（前景色读取失败，已按白色扩展）"; }
  } else if (!extensionColor && canvasExtension === "background") {
    extensionColor = host.getBackgroundRGB();
    if (!extensionColor) { extensionColor = EXT_COLOR_FIXED.white; extensionNote = "（背景色读取失败，已按白色扩展）"; }
  } else if (!extensionColor && canvasExtension === "other") {
    extensionColor = EXT_COLOR_FIXED.white;
    extensionNote = "（自定颜色读取失败，已按白色扩展）";
  }
  disableAll(true);
  status("正在修改画布大小…");
  let failed = false;
  let message;
  try {
    // resizeCanvas 返回 false = 画布改了但扩展颜色没能应用（见 photoshop-host 的回退）。
    let colorApplied = true;
    await host.modal(async () => {
      colorApplied = await host.resizeCanvas(doc, widthPx, heightPx,
        ANCHOR_POSITION[canvasAnchor] || "MIDDLECENTER", extensionColor);
    }, "修改画布大小");
    // 事后核验：AM 路径万一静默没生效（不抛错也不改尺寸），把实际尺寸亮给用户，
    // 不再只报「已修改」。
    let sizeNote = "";
    try {
      if (Number.isFinite(doc.width) && Number.isFinite(doc.height)
          && (Math.abs(doc.width - widthPx) > 1 || Math.abs(doc.height - heightPx) > 1)) {
        sizeNote = "（注意：文档实际 " + Math.round(doc.width) + " × " + Math.round(doc.height)
          + " px，与请求不符，请截图反馈）";
      }
    } catch (_) {}
    message = "画布大小已修改为 " + widthValue + " × " + heightValue + " " + UNIT_NAMES[canvasUnit]
      + "（锚点：" + ANCHOR_LABEL[canvasAnchor]
      + "，扩展颜色：" + EXT_COLOR_NAMES[canvasExtension] + "）。" + sizeNote + extensionNote;
    if (!colorApplied) message += "（注意：扩展颜色未能应用，新增区域可能为透明。）";
  } catch (error) {
    console.error(error);
    message = "画布大小修改失败：" + errorText(error);
    failed = true;
  } finally {
    refresh(false);
    status(message, failed);
  }
}

// 画布卡的「还原」：填了数字还没点「确认修改」又想反悔时，把宽/高两个框
// 恢复成文档当前实际值（按当前单位换算），并清掉编辑标记。只重写显示，不碰文档。
function restoreCanvasSize() {
  if (service.busy) return;
  if (!Number.isFinite(lastDocWidth) || !Number.isFinite(lastDocHeight) || !Number.isFinite(lastResolution)) {
    status("当前没有文档数值可以还原。", true);
    return;
  }
  writeSizeValue("canvasWidth", formatUnitValue(lastDocWidth, canvasUnit, lastResolution));
  writeSizeValue("canvasHeight", formatUnitValue(lastDocHeight, canvasUnit, lastResolution));
  for (const field of ["canvasWidth", "canvasHeight"]) {
    sizeDirty[field] = false;
  }
  if (sizeFocus === "canvasWidth" || sizeFocus === "canvasHeight") sizeFocus = null;
  status("画布数值已还原为文档当前值。");
}

// 「还原」：填了数字还没点「确认修改」又想反悔时，把图片卡三个框恢复成文档当前实际值。
// 只重写显示，不碰文档；同时清掉这几个框的编辑标记，让轮询刷新恢复正常回写。
function restoreImageSize() {
  if (service.busy) return;
  if (!Number.isFinite(lastDocWidth) || !Number.isFinite(lastDocHeight) || !Number.isFinite(lastResolution)) {
    status("当前没有文档数值可以还原。", true);
    return;
  }
  writeSizeValue("imageWidth", formatUnitValue(lastDocWidth, imageUnit, lastResolution));
  writeSizeValue("imageHeight", formatUnitValue(lastDocHeight, imageUnit, lastResolution));
  writeSizeValue("imageResolution", Math.round(lastResolution));
  for (const field of ["imageWidth", "imageHeight", "imageResolution"]) {
    sizeDirty[field] = false;
  }
  sizeLastEdited = null;
  if (sizeFocus === "imageWidth" || sizeFocus === "imageHeight" || sizeFocus === "imageResolution") sizeFocus = null;
  status("已还原为文档当前数值。");
}

// 颜色模式芯片：高亮文档当前模式（非 RGB/CMYK 的模式两个都不亮）。
function renderDocMode(mode) {
  el("modeRGB").className = "mode-option" + (mode === "RGB" ? " active" : "");
  el("modeCMYK").className = "mode-option" + (mode === "CMYK" ? " active" : "");
}

// 点击 RGB/CMYK 芯片：把文档转换成对应颜色模式（已是该模式则只提示，不动文档）。
async function changeDocMode(mode) {
  if (service.busy) return;
  const doc = host.active();
  if (!doc) { status("当前没有打开的文档。", true); return; }
  let current = "";
  try { current = host.getMode(doc); } catch (error) { console.error("读取颜色模式失败:", error); }
  if (current === mode) { status("当前文档已经是 " + mode + " 模式。"); return; }
  disableAll(true);
  status("正在转换为 " + mode + " 模式…");
  let failed = false;
  let message;
  try {
    await host.modal(() => host.changeMode(doc, mode), "转换颜色模式");
    message = "已转换为 " + mode + " 模式。";
  } catch (error) {
    console.error(error);
    message = "颜色模式转换失败：" + errorText(error);
    failed = true;
  } finally {
    refresh(false);
    status(message, failed);
  }
}

/* ---------- 执行（辅助线） ---------- */

async function run(mode) {
  if (service.busy) return;
  disableAll(true);
  status("正在处理辅助线…");
  let message;
  let failed = false;
  try { const result = await service.run(mode); message = result.message; failed = !!result.warning;
    // 删除辅助线 = 全部清空重来：出血值一并归零（老大要求的规则），
    // 之后点版心线 / LOGO / 背书三个按钮就按 0 出血（画布原边）计算。
    if (mode === "clear" && !failed) {
      service.setBleed({ top: 0, bottom: 0, left: 0, right: 0 });
      renderBleedInputs();
      updateBleedPreview();
      message += " 出血值已清零。";
    }
  }
  catch (error) {
    console.error(error);
    message = "未完成：" + errorText(error);
    failed = true;
  } finally {
    setDisabled("visibility", false);
    refresh(false);
    status(message, failed);
  }
}

// 眼睛图标：睁开=辅助线可见，闭眼带斜杠=已隐藏（两个状态各一张 PNG）。
function renderVisibility(visible) {
  const icon = el("eyeIcon");
  if (!icon) return;
  icon.src = visible ? "assets/icon-eye.png" : "assets/icon-eye-off.png";
  const label = visible ? "隐藏辅助线" : "显示辅助线";
  el("visibilityLabel").textContent = label;
  el("visibility").title = label;
  el("visibility").setAttribute("aria-label", label);
}

async function syncVisibility(id) {
  if (visibilityReading || service.busy) return;
  visibilityReading = true;
  try {
    const visible = await host.guideVisibility();
    if (!service.busy && host.active() && host.active().id === id) {
      renderVisibility(visible);
    }
  } catch (error) { console.error(error); }
  finally { visibilityReading = false; }
}

async function toggleVisibility() {
  if (service.busy) return;
  const doc = host.active();
  if (!doc) return;
  service.busy = true;
  disableAll(true);
  let message, failed = false;
  try {
    const visible = await host.modal(() => host.toggleGuides(doc), "显示或隐藏辅助线");
    renderVisibility(visible);
    message = visible ? "辅助线已显示。" : "辅助线已隐藏。";
  } catch (error) { message = "切换失败：" + errorText(error); failed = true; }
  finally { service.busy = false; refresh(false); status(message, failed); }
}

/* ---------- 在线更新 ---------- */

// 页脚只有两行空间，错误信息里那种超长 URL 会把整个页脚撑变形（真机实测过）。
// 这里把 URL 收成「域名/…/末段」，保留辨识度又不占宽度。
function tidyMessage(text) {
  return String(text == null ? "" : text).replace(/https?:\/\/[^\s"']+/g, function (url) {
    const clean = url.replace(/[.,;:）)】\]]+$/, "");
    const slash = clean.indexOf("/", 8);
    if (slash < 0) return clean;
    const segments = clean.slice(slash + 1).split("/").filter(Boolean);
    const tail = segments.length ? segments[segments.length - 1] : "";
    return clean.slice(0, slash) + "/…/" + tail;
  });
}

// 检查更新失败（网络波动 / 防火墙拦截 GitHub / API 限流）：
// 红色提示「更新失败，请手动下载更新。」+ 点亮页脚的「手动更新」链接
//（打开 GitHub 发布页，README 里有最新版下载直链）。
// v1.9.19 起更新消息统一走底部状态条，页脚只留操作入口（行内紧凑排列）。
function showManualDownloadStatus() {
  status("更新失败，请手动下载更新。", true);
  showReleaseButton(true);
}

// 更新消息统一走底部状态条（v1.9.19）：之前写在页脚中段，把窄页脚挤得错位。
function setUpdateStatus(message, error) {
  status(tidyMessage(message), !!error);
}

function releasePage() {
  if (pendingUpdate && pendingUpdate.page) return pendingUpdate.page;
  if (REPO) return "https://github.com/" + REPO + "/releases";
  return "";
}

function showReleaseButton(show) {
  el("openRelease").className = show ? "release-link" : "release-link hidden";
}

// 自动安装走不通时的兜底出口：直接打开 GitHub 发布页手动下载。
async function openRelease() {
  const page = releasePage();
  if (!page) { setUpdateStatus("尚未配置更新仓库，没有可打开的发布页。", true); return; }
  try {
    await shell.openExternal(page);
    setUpdateStatus("已在浏览器中打开：" + page);
  } catch (error) {
    console.error(error);
    setUpdateStatus("打开浏览器失败：" + errorText(error) + " 可手动访问：" + page, true);
  }
}

async function checkUpdate() {
  pendingUpdate = null;
  el("installUpdate").className = "install-button hidden";
  showReleaseButton(false);
  setDisabled("checkUpdate", true);
  setUpdateStatus("正在检查更新…");
  try {
    const result = await update.check(REPO, VERSION, REF_OVERRIDE, SUBDIR);
    pendingUpdate = result;
    if (result.hasUpdate) {
      // 有新版：同时显示「下载并安装更新」和「打开发布页」，让用户能选一键装或者手动下。
      setUpdateStatus("发现新版本 v" + result.latest + "（当前 v" + result.current + "）。");
      el("installUpdate").className = "install-button";
      showReleaseButton(true);
    } else {
      // 没新版：不要显示「打开发布页」—— 已经是最新了还去发布页干嘛？
      // 这条修了一个老 bug：之前无论有没有新版都无条件 showReleaseButton(true)，
      // 导致「已是最新版本」的状态文字和「打开发布页」按钮同屏出现，页脚显得错位。
      showReleaseButton(false);
      setUpdateStatus("已是最新版本（v" + result.current + "）。");
    }
  } catch (error) {
    console.error(error);
    showManualDownloadStatus();
  } finally {
    setDisabled("checkUpdate", false);
  }
}

async function installUpdate() {
  if (!pendingUpdate || !pendingUpdate.hasUpdate) return;
  setDisabled("installUpdate", true);
  setDisabled("checkUpdate", true);
  try {
    let target = await update.resolveTarget();
    if (!target) {
      setUpdateStatus("请在弹窗中选择插件所在的文件夹（Photoshop 的 Plug-ins 里的「品牌版式标准规范PS插件-" + VERSION + "」）。");
      target = await update.chooseTarget();
      if (!target) { setUpdateStatus("已取消选择，更新未执行。"); return; }
    }
    setUpdateStatus("正在下载更新…");
    const count = await update.install(REPO, pendingUpdate.ref, SUBDIR, target, (index, total, path) => {
      setUpdateStatus("正在更新 " + index + "/" + total + " · " + path);
    });
    setUpdateStatus("已更新 " + count + " 个文件。请完全退出并重启 Photoshop，新版本才会生效。");
    pendingUpdate = null;
    el("installUpdate").className = "install-button hidden";
    showReleaseButton(false);   // 安装成功后收起「打开发布页」（之前忘了收，成功后还挂在页脚，用户误以为更新失败）
  } catch (error) {
    console.error(error);
    // 常见于插件目录不可写（例如在 C:\Program Files 下）。保留手动更新入口让用户自行下载覆盖。
    setUpdateStatus("更新失败：" + errorText(error) + " 可点下方「手动更新」下载覆盖。", true);
    showReleaseButton(true);
  } finally {
    setDisabled("installUpdate", false);
    setDisabled("checkUpdate", false);
  }
}

/* ---------- 生命周期 ---------- */

function start() {
  if (!initialized) {
    // 版本号只出现在标题后面。页脚那个 #versionText 已删掉，避免同一个号显示两遍。
    // 版本号带 v 前缀显示（用户要求：v1.9 这种格式）。
    el("footerVersion").textContent = "v" + VERSION;
    // 初始不留提示文字：页脚只有点「检查更新」时才展开这一行。
    setUpdateStatus(REPO ? "" : "更新源待配置");
    // 品牌菜单与出血输入依赖图片和输入框组件，单独兜错，
    // 避免它们出问题时连累辅助线按钮整体不可用。
    try { buildBrandRow(); } catch (error) { console.error("品牌菜单初始化失败:", error); }
    try { renderBleedInputs(); } catch (error) { console.error("出血输入初始化失败:", error); }
    bindAction(el("tabScreen"), () => setTab("screen"));
    bindAction(el("tabPrint"), () => setTab("print"));
    bindAction(el("lock"), toggleLock);
    bindAction(el("bleedReset"), resetBleed);
    bindAction(el("unitMM"), () => setUnit("mm"));
    bindAction(el("unitCM"), () => setUnit("cm"));
    for (const field of BLEED_FIELDS) {
      const valueEl = el("bleed-" + field);
      // 真输入框：原生编辑（光标/选区/退格都是控件自己的），键盘只做过滤和步进（见 onBleedKeydown）。
      valueEl.addEventListener("keydown", event => onBleedKeydown(field, event));
      // 失焦/回车：读框内值校验提交；Esc 由 keydown 里还原。
      valueEl.addEventListener("blur", () => commitBleedEdit(field));
      // 真机上 keydown 拦不住字母（见 sanitizeNumberText 注释），输入时洗一遍。
      valueEl.addEventListener("input", () => {
        const cleaned = sanitizeNumberText(valueEl.value);
        if (cleaned !== valueEl.value) valueEl.value = cleaned;
      });
      valueEl.setAttribute("title", BLEED_LABELS[field] + "出血：直接输入数字，回车或点别处生效");
      bindAction(el("step-up-" + field), () => stepBleed(field, 1));
      bindAction(el("step-down-" + field), () => stepBleed(field, -1));
    }
    for (const id of MODE_BUTTONS) el(id).addEventListener("click", () => { void run(id); });
    // 图片大小 / 画布大小：自绘数值框 + 锁链 + 锚点 + 确认修改
    renderImageLock();
    try { buildAnchorGrid(); } catch (error) { console.error("锚点初始化失败:", error); }
    bindAction(el("imageLock"), toggleImageLock);
    for (const field of SIZE_FIELDS) {
      const valueEl = el(field);
      valueEl.addEventListener("keydown", event => onSizeKeydown(field, event));
      // 用户真的输入过 = dirty：失焦后轮询也不能冲掉输入（v1.9.6 换真输入框时丢了这条，
      // 只有聚焦保护在撑着 —— 点「确认修改」慢一步输入就被刷新回写）。
      // 宽/高另记 sizeLastEdited，锁定比例时按它决定联动方向。
      valueEl.addEventListener("input", () => {
        // 真机上 keydown 拦不住字母（见 sanitizeNumberText 注释），输入时洗一遍。
        const cleaned = sanitizeNumberText(valueEl.value);
        if (cleaned !== valueEl.value) valueEl.value = cleaned;
        sizeDirty[field] = true;
        if (field === "imageWidth" || field === "imageHeight") sizeLastEdited = field;
      });
      // 焦点跟踪给 refresh() 的编辑保护用：聚焦中的框不能被轮询回写。
      valueEl.addEventListener("focus", () => { sizeFocus = field; });
      valueEl.addEventListener("blur", () => { if (sizeFocus === field) sizeFocus = null; });
      // 输入框不直接改状态：失焦/回车只把焦点移走，真正的修改走「确认修改」按钮。
      valueEl.setAttribute("title", "直接输入数字，双击可全选，回车或点「确认修改」生效");
    }
    // 自绘单位下拉：一张卡一个，控制宽/高两行。选中后以文档为准重写换算值。
    buildUnitPicker("imageUnitPicker", function (unit) {
      imageUnit = unit;
      el("imageUnitText").textContent = UNIT_NAMES[unit] || "像素";
      lastSignature = null;   // 单位切换后以文档为准重写换算值
      refresh(false);
      status("图片大小单位：" + (UNIT_NAMES[unit] || "像素") + "。");
    });
    buildUnitPicker("canvasUnitPicker", function (unit) {
      canvasUnit = unit;
      el("canvasUnitText").textContent = UNIT_NAMES[canvasUnit] || "厘米";
      lastSignature = null;
      refresh(false);
      status("画布大小单位：" + (UNIT_NAMES[canvasUnit] || "厘米") + "。");
    });
    // 画布扩展颜色下拉（自绘，同单位下拉同一套代码）+ 色块跟随。
    // 选「其它」：已有自定色就直接切过去；没有则弹出面板内取色器（v1.9.13 起
    // 不再依赖 PS 原生拾色器 —— 它在 UXP 里调不出来）。「其它」上边加分割线。
    // 分割线（v1.9.17）：「背景」下方和「其它」上方各一条 —— 与 PS 原生菜单一样，
    // 把随文档变的（前景/背景）、固定色（白/黑/灰）、自定入口三段隔开。
    extPickerApi = buildOptionPicker("canvasExtPicker", EXT_OPTIONS, option => EXT_COLOR_NAMES[option] || option, function (option) {
      if (option === "other" && !canvasCustomColor) {
        toggleExtPopup();
        return;
      }
      canvasExtension = option;
      renderExtSwatch();
      status("画布扩展颜色：" + (EXT_COLOR_NAMES[option] || option) + "。");
    }, ["white", "other"]);
    renderExtSwatch();
    // 色块可点：弹出面板内取色器（stopPropagation 防止 document 级收起把它关掉）。
    el("canvasExtSwatch").addEventListener("click", function (event) {
      event.stopPropagation();
      toggleExtPopup();
    });
    el("canvasExtSwatch").title = "点这里选画布扩展颜色（预设色板 / 十六进制）";
    // 数值框底色调浅（v1.9.17，老大反馈太黑）：sp-textfield 内部底色是组件写死的
    //（主题、CSS 变量都动不了它），改用「浅灰衬底 + 半透明控件」——见 styles.css
    // 的 .field-wrap。9 个数值框（尺寸 5 + 出血 4）统一包一层，几何保持不变。
    for (const id of ["imageWidth", "imageHeight", "imageResolution", "canvasWidth", "canvasHeight",
                      "bleed-top", "bleed-bottom", "bleed-left", "bleed-right"]) {
      const fieldEl = el(id);
      if (!fieldEl || !fieldEl.parentNode) continue;
      const wrap = document.createElement("span");
      wrap.className = "field-wrap";
      fieldEl.parentNode.insertBefore(wrap, fieldEl);
      wrap.appendChild(fieldEl);
    }
    el("applyImageSize").addEventListener("click", () => { void applyImageSize(); });
    el("applyImageSize").title = "按当前值修改图片大小（executeAsModal 包成一步）";
    bindAction(el("restoreImageSize"), restoreImageSize);
    el("restoreImageSize").title = "放弃当前输入，恢复为文档的实际数值";
    bindAction(el("restoreCanvasSize"), restoreCanvasSize);
    el("restoreCanvasSize").title = "放弃当前输入，恢复为文档的实际数值";
    // 颜色模式芯片：点击把文档转换成对应模式。
    bindAction(el("modeRGB"), () => { void changeDocMode("RGB"); });
    bindAction(el("modeCMYK"), () => { void changeDocMode("CMYK"); });
    el("applyCanvasSize").addEventListener("click", () => { void applyCanvasSize(); });
    el("applyCanvasSize").title = "按当前值修改画布大小（executeAsModal 包成一步）";
    el("clear").addEventListener("click", () => { void run("clear"); });
    el("clear").title = "删除当前文档的全部辅助线（含手动添加）";
    el("visibility").addEventListener("click", () => { void toggleVisibility(); });
    el("visibility").title = "隐藏辅助线";
    el("checkUpdate").addEventListener("click", () => { void checkUpdate(); });
    el("installUpdate").addEventListener("click", () => { void installUpdate(); });
    bindAction(el("openRelease"), () => { void openRelease(); });
    initialized = true;
  }
  setDisabled("visibility", false);
  refresh(true);
  // Lightweight polling avoids dependence on notification event variants.
  if (!timer) timer = setInterval(() => refresh(false), 1200);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function initialize() {
  if (!registered) {
    entrypoints.setup({
      // UXP requires create whenever a plugin lifecycle object is supplied.
      // Panel initialization stays in start(), after the DOM is available.
      plugin: { create() {}, destroy: stop },
      panels: { layoutPanel: { create: start, show: start, hide: stop, destroy: stop } }
    });
    registered = true;
  }
  // Initial display must not depend only on host panel lifecycle callbacks.
  start();
}

module.exports = { initialize };
