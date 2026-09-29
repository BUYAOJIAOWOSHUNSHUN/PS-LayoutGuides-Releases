"use strict";

const ps = require("photoshop");
const { entrypoints, shell, storage } = require("uxp");
const { exportDocument, exportQuickPNG } = require("./export-service.js");
const { pickColor, rgbToHex } = require("./color-picker.js");
const { createPhotoshopHost } = require("./photoshop-host.js");
const { GuideService, errorText } = require("./guide-service.js");
const { BRANDS, findBrand } = require("./brands.js");
const update = require("./update-service.js");
const { unitToPixels, formatUnitValue, imageTarget, imageBytes, formatBytes } = require("./image-size.js");
const { REPO, SUBDIR, REF_OVERRIDE, VERSION } = require("./update-config.js");

const host = createPhotoshopHost(ps);
const service = new GuideService(host);

const BLEED_FIELDS = ["top", "bottom", "left", "right"];
const BLEED_LABELS = { top: "上", bottom: "下", left: "左", right: "右" };
const MODE_BUTTONS = ["update", "logo", "endorsement", "bleed"];
// 三种生成按钮位于页签内容之外，两页真正共用，避免尺寸与事件不同步。
const ALL_BUTTONS = MODE_BUTTONS.concat(["clear", "visibility", "guideLock", "applyImageSize", "applyCanvasSize", "restoreImageSize", "restoreCanvasSize", "modeRGB", "modeCMYK", "exportJPG", "exportPNG", "exportPSD", "exportTIFF"]);

let currentTab = "screen";
let bleedLocked = true;         // 出血四边默认锁定（老大要求）
let bleedUnit = "mm";
let imageLock = true;           // 图片大小的「锁定宽高比」
let canvasAnchor = "center";    // 画布大小的锚点（9 选 1）
let visibilityReading = false;
let timer = null;
let initialized = false;
let lastSignature = null;
let lastCanvasSnapshot = null;
let lastImageSnapshot = null;
let lastResolution = null;
let lastDocWidth = null;    // 文档当前像素尺寸缓存，给「还原」按钮用
let lastDocHeight = null;
let pendingUpdate = null;
let updateBusy = false;
let installedUpdateVersion = "";
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
// 读写统一走 readXxx/writeXxx；「修改」提交、失焦提交等语义不变。

function disableAll(disabled) {
  for (const id of ALL_BUTTONS) setDisabled(id, disabled);
  setDisabled("canvasWidth", disabled);
  setDisabled("canvasHeight", disabled);
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
    if (snapshot) snapshot.bitDepth = host.getBitDepth(host.active());
    const signature = JSON.stringify(snapshot);
    const changed = signature !== lastSignature;
    lastSignature = snapshot ? signature : null;
    disableAll(!snapshot);
    setDisabled("clear", !snapshot || !(snapshot.ownedCount + snapshot.otherCount));
    if (!snapshot) {
      lastCanvasSnapshot = null;
      lastImageSnapshot = null;
      sizeLastEdited = null;
      for (const field of SIZE_FIELDS) sizeDirty[field] = false;
      renderImageSizeSummary();
      renderGuideLock(false);
      lastResolution = null;
      lastDocWidth = null;
      lastDocHeight = null;
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
    const canvasSnapshot = { id: snapshot.id, width: l.width, height: l.height, resolution: snapshot.resolution };
    const canvasChanged = !sameCanvasDocument(canvasSnapshot, lastCanvasSnapshot);
    const imageSnapshot = { ...canvasSnapshot, mode: snapshot.mode, bitDepth: snapshot.bitDepth };
    const imageChanged = !sameImageDocument(imageSnapshot, lastImageSnapshot);
    lastImageSnapshot = imageSnapshot;
    lastCanvasSnapshot = canvasSnapshot;
    lastResolution = snapshot.resolution;
    lastDocWidth = l.width;
    lastDocHeight = l.height;
    el("documentName").textContent = snapshot.name;
    el("dimensions").textContent = px(l.width) + " × " + px(l.height) + " · " + format(snapshot.resolution) + " PPI · " + snapshot.mode;
    renderDocMode(snapshot.mode);
    // 文档变了（切换 / 撤销 / 修改成功）就以文档为准，清掉编辑标记；
    // 文档没变时，聚焦中或编辑过的框不能回写，否则用户输入会被冲掉。
    if (imageChanged) {
      for (const field of ["imageWidth", "imageHeight", "imageResolution"]) sizeDirty[field] = false;
      sizeLastEdited = null;   // 文档已变（撤销/修改成功），联动方向也作废
    }
    if (canvasChanged) { sizeDirty.canvasWidth = false; sizeDirty.canvasHeight = false; }
    const keepUserInput = field => !(field.indexOf("canvas") === 0 ? canvasChanged : imageChanged)
      && (sizeDirty[field] || sizeFocus === field);
    // 图片大小：宽/高按当前单位换算显示，分辨率固定 PPI。
    if (!keepUserInput("imageWidth")) writeSizeValue("imageWidth", formatUnitValue(l.width, imageUnit, snapshot.resolution));
    if (!keepUserInput("imageHeight")) writeSizeValue("imageHeight", formatUnitValue(l.height, imageUnit, snapshot.resolution));
    if (!keepUserInput("imageResolution")) writeSizeValue("imageResolution", snapshot.resolution);
    // 画布大小：宽/高按当前单位换算显示。
    if (!keepUserInput("canvasWidth")) writeSizeValue("canvasWidth", formatUnitValue(l.width, canvasUnit, snapshot.resolution));
    if (!keepUserInput("canvasHeight")) writeSizeValue("canvasHeight", formatUnitValue(l.height, canvasUnit, snapshot.resolution));
    el("bleedGuideState").textContent = snapshot.bleedGuideCount ? "已创建 " + snapshot.bleedGuideCount + " 条" : "尚未创建";
    updateBleedPreview();
    renderExtSwatch();   // 前景/背景色变了色块跟着变（固定色写了也是同一个值，开销可忽略）
    if (changed || explicit) {
      status(snapshot.ownedCount ? "已就绪 · 当前文档已有 " + snapshot.ownedCount + " 条插件辅助线。" : "已就绪 · 可创建版心、LOGO 高度线或出血线。");
    }
    renderImageSizeSummary();
    void syncVisibility(snapshot.id);
  } catch (error) {
    disableAll(true);
    status("读取失败：" + errorText(error), true);
  }
}

/* ---------- 图片大小 / 画布大小 编辑器 ---------- */

// 尺寸使用原生 sp-textfield；失焦或回车仅结束输入，点「修改」才修改文档。
const SIZE_FIELDS = ["imageWidth", "imageHeight", "imageResolution", "canvasWidth", "canvasHeight"];

/* 长度单位（模仿 PS 新建 / 画布大小对话框）：全部以英寸为桥互相换算。
   1 点 = 1/72 英寸，1 派卡 = 12 点 = 1/6 英寸。像素单位不随分辨率缩放。 */
const UNIT_NAMES = { px: "像素", in: "英寸", cm: "厘米", mm: "毫米", pt: "点", pc: "派卡" };
let imageUnit = "px";   // 图片大小卡的单位（宽度/高度两行共用）
let canvasUnit = "cm";  // 画布大小卡的单位

/* ---------- 画布扩展颜色（v1.9.9，模仿 PS「画布大小」对话框） ---------- */
// 选项顺序与 PS 对话框一致：前景 / 背景 / 白色 / 黑色 / 中灰 / 其它。
// 「灰色」改成「中灰」（v1.9.23，老大反馈）：固定值是 128,128,128 的中间灰，
// 叫「中灰」更直观，避免和「随便一种灰」混淆。
// 点色块或选「其它」打开独立 UXP 拾色弹窗；确认后才保存自定颜色。
// 前景/背景在点「修改」时现场读文档的 FG/BG（随用随取，不缓存）；
// 提交时读不到所选颜色则中止并说明原因。扩展颜色只影响新增的画布区域
// （且只对有背景层的文档生效，这是 PS 本身的行为），缩小画布时用不到它。
const EXT_OPTIONS = ["foreground", "background", "white", "black", "gray", "other"];
const EXT_COLOR_NAMES = { foreground: "前景", background: "背景", white: "白色", black: "黑色", gray: "中灰", other: "其它" };
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

let colorDialogOpen = false;

async function openCanvasColorPicker() {
  if (service.busy || colorDialogOpen) return;
  colorDialogOpen = true;
  try {
    const selected = await pickColor(document, effectiveExtColor());
    if (selected) {
      canvasCustomColor = { r: selected.r, g: selected.g, b: selected.b };
      canvasExtension = "other";
      renderExtSwatch();
      status("画布扩展颜色：#" + rgbToHex(selected).replace(/^#/, "") + "。");
    }
  } catch (error) {
    console.error(error);
    status("拾色器打开失败：" + errorText(error), true);
  } finally {
    colorDialogOpen = false;
    if (extPickerApi) extPickerApi.set(canvasExtension);
  }
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
          if (service.busy || colorDialogOpen) { close(); return; }
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
    if (service.busy || colorDialogOpen) { close(); return; }
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
// （撤销 / 修改成功，两种都会让快照签名变化）之前也不回写。
const sizeDirty = {};
let sizeFocus = null;
// 锁定比例时「以谁为准」：最后编辑的是宽还是高（v1.9.8 修复）。
// 之前永远保留宽、按比例重算高 —— 用户只改高度时会被拉回原比例，
// 请求尺寸 = 原尺寸，PS 无事可做，表现就是「点修改不动、数值弹回去」。
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
    if (field.indexOf("image") === 0) { el(field).blur(); restoreImageSize(); return; }
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
  if (service.busy) return;
  imageLock = !imageLock;
  renderImageLock();
  syncImageDraft(sizeLastEdited);
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
  if (service.busy || colorDialogOpen) return;
  canvasAnchor = id;
  renderAnchor();
  status("画布锚点已选：" + ANCHOR_LABEL[id] + "。");
}

function imageDocumentState(doc) {
  return doc ? { ...canvasDocumentState(doc), mode: host.getMode(doc), bitDepth: host.getBitDepth(doc) } : null;
}

function sameImageDocument(a, b) {
  return sameCanvasDocument(a, b) && a.mode === b.mode && a.bitDepth === b.bitDepth;
}

function readImageTarget() {
  return imageTarget({ width: readSizeValue("imageWidth"), height: readSizeValue("imageHeight"),
    resolution: readSizeValue("imageResolution"), unit: imageUnit, locked: imageLock,
    lastEdited: sizeLastEdited }, lastImageSnapshot);
}

function syncImageDraft(field) {
  if (imageLock && (field === "imageWidth" || field === "imageHeight")) {
    const target = readImageTarget();
    if (target) {
      const other = field === "imageWidth" ? "imageHeight" : "imageWidth";
      writeSizeValue(other, formatUnitValue(field === "imageWidth" ? target.height : target.width, imageUnit, target.resolution));
      sizeDirty[other] = true;
    }
  }
  renderImageSizeSummary();
}

function renderImageSizeSummary() {
  const target = readImageTarget();
  const base = lastImageSnapshot;
  if (!base) { el("imageSizeSummary").textContent = "图像大小：—"; return; }
  const original = imageBytes(base.width, base.height, base.mode, base.bitDepth);
  const estimate = target ? imageBytes(target.width, target.height, base.mode, base.bitDepth) : null;
  el("imageSizeSummary").textContent = "图像大小：" + formatBytes(estimate)
    + (estimate === original && estimate !== null ? "" : "（之前为 " + formatBytes(original) + "）");
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
  if (!sameImageDocument(imageDocumentState(doc), lastImageSnapshot)) {
    refresh(false);
    status("文档或尺寸已变化，请检查刷新后的数值再修改。", true);
    return;
  }
  const target = readImageTarget();
  if (!target) { status("请输入有效的宽、高和分辨率；换算后的尺寸须为 1–300000 像素。", true); return; }
  const source = { ...lastImageSnapshot };
  const { width: widthPx, height: heightPx, resolution } = target;
  if (widthPx === lastImageSnapshot.width && heightPx === lastImageSnapshot.height && resolution === lastImageSnapshot.resolution) {
    restoreImageSize();
    status("图片大小与当前文档一致。");
    return;
  }
  service.busy = true;
  disableAll(true);
  status("正在修改图片大小…");
  let failed = false;
  let message;
  try {
    await host.modal(async () => {
      if (!sameImageDocument(imageDocumentState(host.active()), source)) {
        throw new Error("文档或尺寸已变化，请检查刷新后的数值再修改。");
      }
      await host.resizeImage(doc, widthPx, heightPx, resolution);
    }, "修改图片大小");
    message = "图片大小已修改为 " + widthPx + " × " + heightPx + " 像素（按" + UNIT_NAMES[imageUnit] + "输入）· " + resolution + " PPI。";
  } catch (error) {
    console.error(error);
    message = "图片大小修改失败：" + errorText(error);
    failed = true;
  } finally {
    service.busy = false;
    refresh(false);
    status(message, failed);
  }
}

function canvasDocumentState(doc) {
  return doc ? { id: doc.id, width: Number(doc.width), height: Number(doc.height), resolution: Number(doc.resolution) } : null;
}

function sameCanvasDocument(a, b) {
  return !!a && !!b && a.id === b.id && a.width === b.width && a.height === b.height && a.resolution === b.resolution;
}

async function applyCanvasSize() {
  if (service.busy || colorDialogOpen) return;
  const doc = host.active();
  if (!doc) { refresh(false); status("当前没有打开的文档。", true); return; }
  const source = canvasDocumentState(doc);
  if (!sameCanvasDocument(source, lastCanvasSnapshot)) {
    refresh(false);
    status("文档或尺寸已变化，已刷新画布数值，请重新输入后确认。", true);
    return;
  }
  if (!Number.isFinite(source.resolution) || source.resolution <= 0) {
    status("无法读取文档分辨率，画布大小修改中止。", true);
    return;
  }
  const widthValue = parsePositive(readSizeValue("canvasWidth"));
  const heightValue = parsePositive(readSizeValue("canvasHeight"));
  if (widthValue == null || heightValue == null) {
    status("画布大小的宽、高都必须是大于 0 的数字。", true);
    return;
  }
  const unit = canvasUnit, anchor = canvasAnchor, extension = canvasExtension;
  // 物理单位只显示两位小数；未改变的显示值沿用原像素，避免另一边被舍入误改。
  const targetPixels = (value, original) => value === Number(formatUnitValue(original, unit, source.resolution))
    ? original : Math.round(unitToPixels(value, unit, source.resolution));
  const widthPx = targetPixels(widthValue, source.width);
  const heightPx = targetPixels(heightValue, source.height);
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx < 1 || heightPx < 1) {
    status("换算后的画布宽、高至少需要 1 像素。", true);
    return;
  }
  if (widthPx === source.width && heightPx === source.height) {
    restoreCanvasSize();
    status("画布尺寸未改变。");
    return;
  }
  let extensionColor = EXT_COLOR_FIXED[extension] || null;
  if (extension === "foreground") extensionColor = host.getForegroundRGB();
  if (extension === "background") extensionColor = host.getBackgroundRGB();
  if (extension === "other") extensionColor = canvasCustomColor;
  if (!extensionColor) {
    status("无法读取所选扩展颜色，请重新选择颜色后确认。", true);
    return;
  }
  extensionColor = { r: extensionColor.r, g: extensionColor.g, b: extensionColor.b };
  service.busy = true;
  disableAll(true);
  status("正在修改画布大小…");
  let failed = false;
  let message;
  try {
    let colorApplied = true;
    await host.modal(async context => {
      if (!sameCanvasDocument(canvasDocumentState(host.active()), source)) {
        throw new Error("文档或尺寸已变化，本次未执行修改，请重新输入后确认。");
      }
      colorApplied = await host.resizeCanvas(doc, widthPx, heightPx,
        ANCHOR_POSITION[anchor] || "MIDDLECENTER", extensionColor, context);
    }, "修改画布大小");
    sizeDirty.canvasWidth = false;
    sizeDirty.canvasHeight = false;
    if (sizeFocus === "canvasWidth" || sizeFocus === "canvasHeight") sizeFocus = null;
    message = "画布大小已修改为 " + widthPx + " × " + heightPx + " 像素（锚点：" + ANCHOR_LABEL[anchor]
      + "，扩展颜色：" + EXT_COLOR_NAMES[extension] + "）。";
    if (!colorApplied) message += "当前文档无背景层，新增区域保持透明。";
  } catch (error) {
    console.error(error);
    message = "画布大小修改失败：" + errorText(error);
    failed = true;
  } finally {
    service.busy = false;
    refresh(false);
    status(message, failed);
  }
}

// 只放弃未提交输入，重新读取当前文档，不修改 Photoshop 文档。
function restoreCanvasSize() {
  if (service.busy) return;
  sizeDirty.canvasWidth = false;
  sizeDirty.canvasHeight = false;
  if (sizeFocus === "canvasWidth" || sizeFocus === "canvasHeight") sizeFocus = null;
  refresh(false);
  status(lastCanvasSnapshot ? "画布数值已还原为文档当前值。" : "当前没有文档数值可以还原。", !lastCanvasSnapshot);
}

// 「还原」：填了数字还没点「修改」又想反悔时，把图片卡三个框恢复成文档当前实际值。
// 只重写显示，不碰文档；同时清掉这几个框的编辑标记，让轮询刷新恢复正常回写。
function restoreImageSize() {
  if (service.busy) return;
  if (!Number.isFinite(lastDocWidth) || !Number.isFinite(lastDocHeight) || !Number.isFinite(lastResolution)) {
    status("当前没有文档数值可以还原。", true);
    return;
  }
  writeSizeValue("imageWidth", formatUnitValue(lastDocWidth, imageUnit, lastResolution));
  writeSizeValue("imageHeight", formatUnitValue(lastDocHeight, imageUnit, lastResolution));
  writeSizeValue("imageResolution", lastResolution);
  for (const field of ["imageWidth", "imageHeight", "imageResolution"]) {
    sizeDirty[field] = false;
  }
  sizeLastEdited = null;
  if (sizeFocus === "imageWidth" || sizeFocus === "imageHeight" || sizeFocus === "imageResolution") sizeFocus = null;
  renderImageSizeSummary();
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
  service.busy = true;
  disableAll(true);
  status("正在转换为 " + mode + " 模式…");
  let failed = false;
  let message;
  try {
    await host.modal(context => host.changeMode(doc, mode, context), "转换颜色模式");
    message = "已转换为 " + mode + " 模式，图层结构已核验保留。";
  } catch (error) {
    console.error(error);
    message = "颜色模式转换失败：" + errorText(error);
    failed = true;
  } finally {
    service.busy = false;
    refresh(false);
    status(message, failed);
  }
}

async function quickExport(format) {
  if (service.busy || colorDialogOpen) return;
  const doc = host.active();
  if (!doc) { status("当前没有打开的文档。", true); return; }
  service.busy = true;
  disableAll(true);
  let message = "已取消导出。", failed = false, exportCancelled = false;
  try {
    if (format === "png") {
      status("正在调用 Photoshop 快速导出为 PNG…");
      await exportQuickPNG(ps, doc);
      message = "已调用 Photoshop 快速导出为 PNG。";
      return;
    }
    const saveFormats = {
      jpg: { extension: "jpg", types: ["jpg"] },
      psd: { extension: "psd", types: ["psd"] },
      tiff: { extension: "tif", types: ["tif", "tiff"] }
    };
    const saveFormat = saveFormats[format];
    if (!saveFormat) throw new Error("请选择 JPG、PNG、PSD 或 TIFF 格式。");
    const name = String(doc.name || "未标题").replace(/\.(psd|psb|jpe?g|png|tiff?|webp|gif|bmp|pdf)$/i, "").replace(/[\\/:*?"<>|]/g, "_");
    const file = await storage.localFileSystem.getFileForSaving(name + "." + saveFormat.extension, { types: saveFormat.types });
    if (!file) return;
    status("正在导出 " + format.toUpperCase() + "…");
    await host.modal(async context => {
      try { return await exportDocument(ps, doc, format, file, context); }
      catch (error) {
        // Photoshop can strip custom Error fields across executeAsModal.
        exportCancelled = !!(error && (error.cancelled || error.code === "EXPORT_CANCELLED"));
        throw error;
      }
    }, "快速导出 " + format.toUpperCase());
    message = "已导出 " + format.toUpperCase() + "：" + file.name + "。";
  } catch (error) {
    console.error(error);
    if (exportCancelled || (error && (error.cancelled || error.code === "EXPORT_CANCELLED"))) {
      message = "已取消导出。";
    } else {
      message = "导出失败：" + errorText(error);
      failed = true;
    }
  } finally {
    service.busy = false;
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
    const locked = await host.guidesLocked();
    if (!service.busy && host.active() && host.active().id === id) renderGuideLock(locked);
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

function renderGuideLock(locked) {
  el("guideLockIcon").src = locked ? "assets/icon-lock.png" : "assets/icon-unlock.png";
  const label = locked ? "解锁辅助线" : "锁定辅助线";
  el("guideLock").className = "guide-lock-button" + (locked ? " locked" : "");
  el("guideLock").title = label;
  el("guideLock").setAttribute("aria-label", label);
  el("guideLock").setAttribute("aria-pressed", String(locked));
}

async function toggleGuideLock() {
  if (service.busy) return;
  const doc = host.active();
  if (!doc) return;
  service.busy = true;
  disableAll(true);
  let message, failed = false;
  try {
    const locked = await host.modal(() => host.toggleGuideLock(doc), "锁定或解锁辅助线");
    renderGuideLock(locked);
    message = locked ? "辅助线已锁定。" : "辅助线已解锁。";
  } catch (error) { message = "切换锁定失败：" + errorText(error); failed = true; }
  finally { service.busy = false; refresh(false); status(message, failed); }
}

/* ---------- 在线更新 ---------- */

// 页脚空间有限，错误信息里的超长 URL 会把整个页脚撑变形。
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

// 更新反馈独立显示，文档轮询和普通操作不会覆盖下载进度。
function setUpdateStatus(message, error) {
  el("updateFeedback").className = message ? "update-feedback" : "update-feedback hidden";
  el("updateStatus").textContent = tidyMessage(message);
  el("updateStatus").className = error ? "update-status error" : "update-status";
}

function renderUpdateProgress(progress) {
  const labels = { prepare: "正在准备更新…", download: "正在下载…", backup: "正在备份…", install: "正在安装…", rollback: "正在恢复原版本…" };
  const phase = progress && progress.phase;
  const hasPercent = progress && Number.isFinite(progress.percent) && phase !== "complete";
  el("updateProgress").className = hasPercent ? "update-progress" : "update-progress hidden";
  el("updatePercent").className = hasPercent ? "update-percent" : "update-percent hidden";
  if (hasPercent) {
    const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
    el("updatePercent").textContent = percent + "%";
    el("updateProgressFill").style.width = percent + "%";
    el("updateProgress").setAttribute("aria-valuenow", String(percent));
    el("updateProgress").setAttribute("aria-label", labels[phase] || "更新进度");
  }
  if (labels[phase]) setUpdateStatus(labels[phase]);
}

function showUpdateLocation(path) {
  el("updateLocation").textContent = path ? "安装位置：" + path : "";
  el("updateLocation").title = path || "";
  el("updateLocation").className = path ? "update-location" : "update-location hidden";
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
  if (updateBusy) return;
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
  if (updateBusy || service.busy) return;
  if (installedUpdateVersion) {
    setUpdateStatus("v" + installedUpdateVersion + " 已安装，重启 Photoshop 后生效。");
    return;
  }
  updateBusy = true;
  pendingUpdate = null;
  showUpdateLocation("");
  renderUpdateProgress(null);
  el("installUpdate").className = "install-button hidden";
  showReleaseButton(false);
  setDisabled("checkUpdate", true);
  setUpdateStatus("正在检查更新…");
  try {
    const result = await update.check(REPO, VERSION, REF_OVERRIDE, SUBDIR);
    pendingUpdate = result;
    if (result.hasUpdate) {
      setUpdateStatus("发现新版本 v" + result.latest + "。");
      el("installUpdate").className = "install-button";
      showReleaseButton(false);
    } else {
      // 没新版：不要显示「打开发布页」—— 已经是最新了还去发布页干嘛？
      // 这条修了一个老 bug：之前无论有没有新版都无条件 showReleaseButton(true)，
      // 导致「已是最新版本」的状态文字和「打开发布页」按钮同屏出现，页脚显得错位。
      showReleaseButton(false);
      setUpdateStatus(result.isAhead ? "本地 v" + result.current + "，线上最新 v" + result.latest + "。" : "已是最新版本（v" + result.current + "）。");
    }
  } catch (error) {
    console.error(error);
    setUpdateStatus("检查更新失败：" + errorText(error) + "。可打开发布页手动下载。", true);
    showReleaseButton(true);
  } finally {
    updateBusy = false;
    setDisabled("checkUpdate", false);
  }
}

async function installUpdate() {
  let target = null;
  if (updateBusy || service.busy || colorDialogOpen || !pendingUpdate || !pendingUpdate.hasUpdate) return;
  const release = pendingUpdate;
  updateBusy = true;
  service.busy = true;
  disableAll(true);
  showReleaseButton(false);
  setDisabled("installUpdate", true);
  setDisabled("checkUpdate", true);
  renderUpdateProgress(null);
  showUpdateLocation("");
  setUpdateStatus("正在准备更新…");
  try {
    target = await update.resolveTarget();
    if (!target) {
      showUpdateLocation(await update.getTargetLocation());
      setUpdateStatus("请确认下方插件文件夹，无需输入路径；将记住此次授权。");
      target = await update.chooseTarget();
      if (!target) { showUpdateLocation(""); setUpdateStatus("已取消授权，更新未执行。"); return; }
    }
    showUpdateLocation("");
    await update.install(REPO, release.ref, SUBDIR, target, renderUpdateProgress);
    installedUpdateVersion = release.latest;
    renderUpdateProgress(null);
    setUpdateStatus("v" + release.latest + " 已安装，重启 Photoshop 后生效。");
    pendingUpdate = null;
    el("installUpdate").className = "install-button hidden";
    showReleaseButton(false);   // 安装成功后收起「打开发布页」（之前忘了收，成功后还挂在页脚，用户误以为更新失败）
  } catch (error) {
    console.error(error);
    renderUpdateProgress(null);
    const text = errorText(error);
    setUpdateStatus("更新失败：" + text + " 可点「手动更新」下载覆盖。", true);
    showReleaseButton(true);
  } finally {
    updateBusy = false;
    service.busy = false;
    setDisabled("installUpdate", false);
    setDisabled("checkUpdate", false);
    refresh(false);
  }
}

/* ---------- 生命周期 ---------- */

function start() {
  if (!initialized) {
    // 页脚统一显示当前运行版本。
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
    // 图片大小 / 画布大小：自绘数值框 + 锁链 + 锚点 + 修改
    renderImageLock();
    try { buildAnchorGrid(); } catch (error) { console.error("锚点初始化失败:", error); }
    bindAction(el("imageLock"), toggleImageLock);
    for (const field of SIZE_FIELDS) {
      const valueEl = el(field);
      valueEl.addEventListener("keydown", event => onSizeKeydown(field, event));
      // 用户真的输入过 = dirty：失焦后轮询也不能冲掉输入（v1.9.6 换真输入框时丢了这条，
      // 只有聚焦保护在撑着 —— 点「修改」慢一步输入就被刷新回写）。
      // 宽/高另记 sizeLastEdited，锁定比例时按它决定联动方向。
      valueEl.addEventListener("input", () => {
        // 真机上 keydown 拦不住字母（见 sanitizeNumberText 注释），输入时洗一遍。
        const cleaned = sanitizeNumberText(valueEl.value);
        if (cleaned !== valueEl.value) valueEl.value = cleaned;
        sizeDirty[field] = true;
        if (field === "imageWidth" || field === "imageHeight") sizeLastEdited = field;
        if (field.indexOf("image") === 0) syncImageDraft(sizeLastEdited);
      });
      // 焦点跟踪给 refresh() 的编辑保护用：聚焦中的框不能被轮询回写。
      valueEl.addEventListener("focus", () => { sizeFocus = field; });
      valueEl.addEventListener("blur", () => { if (sizeFocus === field) sizeFocus = null; });
      // 输入框不直接改状态：失焦/回车只把焦点移走，真正的修改走「修改」按钮。
      valueEl.setAttribute("title", "直接输入数字，双击可全选，点「修改」生效");
    }
    // 自绘单位下拉：一张卡一个，控制宽/高两行。选中后以文档为准重写换算值。
    buildUnitPicker("imageUnitPicker", function (unit) {
      imageUnit = unit;
      lastImageSnapshot = null;
      el("imageUnitText").textContent = UNIT_NAMES[unit] || "像素";
      lastSignature = null;   // 单位切换后以文档为准重写换算值
      refresh(false);
      status("图片大小单位：" + (UNIT_NAMES[unit] || "像素") + "。");
    });
    buildUnitPicker("canvasUnitPicker", function (unit) {
      canvasUnit = unit;
      el("canvasUnitText").textContent = UNIT_NAMES[canvasUnit] || "厘米";
      lastCanvasSnapshot = null;
      refresh(false);
      status("画布大小单位：" + (UNIT_NAMES[canvasUnit] || "厘米") + "。");
    });
    // 「其它」和色块都打开独立弹窗；取消时恢复原选项。
    extPickerApi = buildOptionPicker("canvasExtPicker", EXT_OPTIONS, option => EXT_COLOR_NAMES[option] || option, function (option) {
      if (option === "other") { void openCanvasColorPicker(); return; }
      canvasExtension = option;
      renderExtSwatch();
      status("画布扩展颜色：" + (EXT_COLOR_NAMES[option] || option) + "。");
    }, ["white", "other"]);
    renderExtSwatch();
    bindAction(el("canvasExtSwatch"), () => { void openCanvasColorPicker(); });
    el("canvasExtSwatch").title = "选择画布扩展颜色";
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
      // 内联透明度做双保险：真机上 .field-wrap > sp-textfield 的子选择器可能没匹配上。
      fieldEl.style.opacity = "0.45";
    }
    el("applyImageSize").addEventListener("click", () => { void applyImageSize(); });
    el("applyImageSize").title = "按当前值修改图片大小";
    bindAction(el("restoreImageSize"), restoreImageSize);
    el("restoreImageSize").title = "放弃当前输入，恢复为文档的实际数值";
    bindAction(el("restoreCanvasSize"), restoreCanvasSize);
    el("restoreCanvasSize").title = "放弃当前输入，恢复为文档的实际数值";
    // 颜色模式芯片：点击把文档转换成对应模式。
    bindAction(el("modeRGB"), () => { void changeDocMode("RGB"); });
    bindAction(el("modeCMYK"), () => { void changeDocMode("CMYK"); });
    bindAction(el("exportJPG"), () => { void quickExport("jpg"); });
    bindAction(el("exportPNG"), () => { void quickExport("png"); });
    bindAction(el("exportPSD"), () => { void quickExport("psd"); });
    bindAction(el("exportTIFF"), () => { void quickExport("tiff"); });
    el("applyCanvasSize").addEventListener("click", () => { void applyCanvasSize(); });
    el("applyCanvasSize").title = "按当前值修改画布大小";
    el("clear").addEventListener("click", () => { void run("clear"); });
    el("clear").title = "删除当前文档的全部辅助线（含手动添加）";
    el("visibility").addEventListener("click", () => { void toggleVisibility(); });
    el("visibility").title = "隐藏辅助线";
    el("guideLock").addEventListener("click", () => { void toggleGuideLock(); });
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
