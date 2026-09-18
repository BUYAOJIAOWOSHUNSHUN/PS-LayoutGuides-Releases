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
const ALL_BUTTONS = MODE_BUTTONS.concat(["clear", "visibility", "applyImageSize", "applyCanvasSize"]);

let currentTab = "screen";
let bleedLocked = false;
let bleedUnit = "mm";
let imageLock = true;           // 图片大小的「锁定宽高比」
let canvasAnchor = "center";    // 画布大小的锚点（9 选 1）
let aspectRatio = 1;            // 当前文档的宽高比，用于锁定时换算
let visibilityReading = false;
let timer = null;
let initialized = false;
let lastSignature = null;
let lastResolution = null;
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

/* ---------- 自绘数值框公共件：闪烁光标 + 拖拽全选 ---------- */
// 数值框是自绘 span（UXP 没有可用的透明文本输入控件），原生没有光标也不能选字。
// 这里按 PS 输入框的样子补齐两件事：
//   1. 聚焦时在文本末尾插一根 1px 竖线（.caret），定时器切 visibility 模拟闪烁；
//   2. 数值拆成单字符 span（.ch），按住拖动 / 双击把区间内的字符加蓝底（.sel）。
// 我们的编辑模型没有光标定位（首键替换、之后追加），所以光标永远在末尾，与模型一致。
const caretState = { valueEl: null, node: null, timer: null, on: true };

function isCharSpan(node) {
  return node.className === "ch" || node.className === "ch sel";
}

function charSpans(valueEl) {
  const result = [];
  for (let i = 0; i < valueEl.childNodes.length; i++) {
    const node = valueEl.childNodes[i];
    if (node.nodeType === 1 && isCharSpan(node)) result.push(node);
  }
  return result;
}

// 读值 = 拼接所有字符 span（光标 span 没有文本，混进来也无妨）。
function valueText(valueEl) {
  return charSpans(valueEl).map(span => span.textContent).join("");
}

// 重建字符 span；focused=true 时在末尾补光标并重新开始闪烁。
function renderChars(valueEl, text, focused) {
  const wasFocused = focused || caretState.valueEl === valueEl;
  clearChildren(valueEl);
  const string = String(text);
  for (let i = 0; i < string.length; i++) {
    const span = document.createElement("span");
    span.className = "ch";
    span.textContent = string.charAt(i);
    valueEl.appendChild(span);
  }
  if (wasFocused) attachCaret(valueEl);
}

function attachCaret(valueEl) {
  detachCaret();
  const caret = document.createElement("span");
  caret.className = "caret";
  valueEl.appendChild(caret);
  caretState.valueEl = valueEl;
  caretState.node = caret;
  caretState.on = true;
  caretState.timer = setInterval(() => {
    caretState.on = !caretState.on;
    if (caretState.node) caretState.node.className = caretState.on ? "caret" : "caret off";
  }, 530);
}

function detachCaret() {
  if (caretState.timer) { clearInterval(caretState.timer); caretState.timer = null; }
  if (caretState.node && caretState.node.parentNode) caretState.node.parentNode.removeChild(caretState.node);
  caretState.valueEl = null;
  caretState.node = null;
  caretState.on = true;
}

/* 选中区间：每个数值框一份，start === end 表示只有光标点、没有选中。 */
const valueSelection = new Map();

function applySelection(valueEl) {
  const selection = valueSelection.get(valueEl);
  const spans = charSpans(valueEl);
  const lo = selection ? Math.min(selection.start, selection.end) : 0;
  const hi = selection ? Math.max(selection.start, selection.end) : 0;
  for (let i = 0; i < spans.length; i++) spans[i].className = i >= lo && i < hi ? "ch sel" : "ch";
}

function clearSelection(valueEl) {
  if (valueSelection.delete(valueEl)) applySelection(valueEl);
}

function hasSelection(valueEl) {
  const selection = valueSelection.get(valueEl);
  return !!selection && selection.start !== selection.end;
}

// x 落在第几个字符上：优先用每个字符自己的矩形，拿不到矩形就按宽度比例估算。
function charIndexAt(valueEl, clientX) {
  const spans = charSpans(valueEl);
  if (!spans.length) return 0;
  try {
    for (let i = 0; i < spans.length; i++) {
      const rect = spans[i].getBoundingClientRect();
      if (rect && typeof rect.left === "number" && clientX < rect.left + rect.width / 2) return i;
    }
    return spans.length;
  } catch (error) {
    try {
      const box = valueEl.getBoundingClientRect();
      const perChar = (box.width - 12) / Math.max(1, spans.length);   // 12 ≈ 左右 padding
      return Math.max(0, Math.min(spans.length, Math.round((clientX - box.left - 6) / perChar)));
    } catch (_) { return spans.length; }
  }
}

// 拖拽选择 + 双击全选。mousemove 只在按住拖动时生效；选中后敲键 = 整个替换（见各 keydown）。
function wireValueMouse(valueEl) {
  let dragging = false;
  let anchor = 0;
  let lastDown = 0;
  valueEl.addEventListener("mousedown", event => {
    const now = Date.now();
    const doubleClick = now - lastDown < 350;
    lastDown = now;
    if (doubleClick) {
      dragging = false;
      valueSelection.set(valueEl, { anchor: 0, start: 0, end: charSpans(valueEl).length });
      applySelection(valueEl);
      return;
    }
    dragging = true;
    anchor = charIndexAt(valueEl, event.clientX);
    valueSelection.set(valueEl, { anchor, start: anchor, end: anchor });
    applySelection(valueEl);
  });
  valueEl.addEventListener("mousemove", event => {
    if (!dragging) return;
    const index = charIndexAt(valueEl, event.clientX);
    valueSelection.set(valueEl, { anchor, start: anchor, end: index });
    applySelection(valueEl);
  });
  const endDrag = () => { dragging = false; };
  valueEl.addEventListener("mouseup", endDrag);
  valueEl.addEventListener("mouseleave", endDrag);
}

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

/* ---------- 自绘数值框 ---------- */

// 出血数值框不是 sp-textfield，是自己画的 span。
// 原因：UXP 的 sp-textfield 内部底色写死（真机实测 #1e1e1e），
// --spectrum-textfield-background-color 盖不掉、quiet 变体也只去了边框，
// 外面套一层浅灰容器就成了「灰框里挖了个黑洞」。
// 读写统一走下面两个函数，将来要换回原生输入框只改这里。
const editing = {};

function readBleedValue(field) {
  return valueText(el("bleed-" + field)).trim();
}

// 外部改写（重新渲染 / 步进 / 提交后回写）：丢掉编辑中的临时串与选中态。
function writeBleedValue(field, text) {
  renderChars(el("bleed-" + field), text, false);
  clearSelection(el("bleed-" + field));
  editing[field] = null;
}

// 编辑中的临时串：只改显示，不落库；保留光标与选中态由调用方决定。
function writeBleedEdit(field, text) {
  renderChars(el("bleed-" + field), text, true);
  editing[field] = text;
}

// 自绘输入框的键盘输入。UXP 里除 sp-textfield 外没有可用的文本输入控件，
// 所以数字、小数点、退格都自己接：只收 [0-9.]，退格删一位，回车提交，Esc 还原。
// 上下箭头复用已有的 stepBleed。焦点态由 .bleed-value:focus 给底色。
function onBleedKeydown(field, event) {
  const key = event.key;
  const valueEl = el("bleed-" + field);
  if (key === "ArrowUp" || key === "ArrowDown") {
    event.preventDefault();
    stepBleed(field, key === "ArrowUp" ? 1 : -1);
    return;
  }
  if (key === "Enter") { event.preventDefault(); commitBleedEdit(field); return; }
  if (key === "Escape") {
    event.preventDefault();
    editing[field] = null;
    clearSelection(valueEl);
    renderBleedInputs();
    updateBleedPreview();
    return;
  }
  if (key === "Backspace") {
    event.preventDefault();
    if (hasSelection(valueEl)) { clearSelection(valueEl); writeBleedEdit(field, "0"); return; }
    const current = editing[field] == null ? readBleedValue(field) : editing[field];
    const next = current.slice(0, -1);
    renderChars(valueEl, next === "" ? "0" : next, true);
    editing[field] = next;
    return;
  }
  const isDigit = typeof key === "string" && key.length === 1 && key >= "0" && key <= "9";
  if (isDigit || key === ".") {
    event.preventDefault();
    // 自绘控件没有光标，「追加」会让显示 2 时敲 3 变成 23。
    // 所以**本次编辑的第一个按键替换原值**，之后才是追加 ——
    // 等价于原生输入框获得焦点时全选，行为可预期。
    // 有选中（拖拽/双击选的蓝色高亮）时敲键 = 整个替换，跟 PS 的输入框一致。
    if (hasSelection(valueEl)) {
      editing[field] = key === "." ? "0." : key;
    } else if (editing[field] == null) {
      editing[field] = key === "." ? "0." : key;
    } else {
      if (key === "." && editing[field].indexOf(".") >= 0) return;   // 只允许一个小数点
      editing[field] = editing[field] + key;
    }
    renderChars(valueEl, editing[field], true);
    clearSelection(valueEl);
  }
}

// 把编辑中的串提交给 service。空串按 0 处理，不让用户卡在错误态。
// 没在编辑（editing 为 null）时直接返回 —— 失焦、点步进都会走到这里，不能白跑。
function commitBleedEdit(field) {
  if (editing[field] == null) return;
  const raw = editing[field];
  editing[field] = null;
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
  const raw = (editing[field] == null ? readBleedValue(field) : editing[field]).trim();
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
  for (const field of BLEED_FIELDS) editing[field] = null;   // 丢弃没提交的编辑
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
  editing[field] = null;
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
      aspectRatio = 1;
      el("documentName").textContent = "请打开 Photoshop 文档";
      el("dimensions").textContent = "以整个文档画布为基准";
      el("bleedGuideState").textContent = "尚未创建";
      writeSizeValue("imageWidth", "0");
      writeSizeValue("imageHeight", "0");
      writeSizeValue("imageResolution", "0");
      writeSizeValue("canvasWidth", "0");
      writeSizeValue("canvasHeight", "0");
      updateBleedPreview();
      if (changed || explicit) status("当前没有打开的文档。");
      return;
    }
    const l = snapshot.layout;
    lastResolution = snapshot.resolution;
    aspectRatio = l.width / l.height || 1;
    el("documentName").textContent = snapshot.name;
    el("dimensions").textContent = px(l.width) + " × " + px(l.height) + " · " + format(snapshot.resolution) + " PPI";
    // 文档变了（切换 / 撤销 / 确认修改成功）就以文档为准，清掉编辑标记；
    // 文档没变时，聚焦中或编辑过的框不能回写，否则用户输入会被冲掉。
    if (changed) {
      for (let i = 0; i < SIZE_FIELDS.length; i++) sizeDirty[SIZE_FIELDS[i]] = false;
    }
    const keepUserInput = field => !changed && (sizeDirty[field] || sizeFocus === field);
    // 图片大小：像素 + 当前文档的分辨率。
    if (!keepUserInput("imageWidth")) writeSizeValue("imageWidth", Math.round(l.width));
    if (!keepUserInput("imageHeight")) writeSizeValue("imageHeight", Math.round(l.height));
    if (!keepUserInput("imageResolution")) writeSizeValue("imageResolution", Math.round(snapshot.resolution));
    // 画布大小：厘米 + 当前文档的分辨率换算。
    const cmPerInch = 2.54;
    if (!keepUserInput("canvasWidth")) writeSizeValue("canvasWidth", Number((l.width / snapshot.resolution * cmPerInch).toFixed(2)));
    if (!keepUserInput("canvasHeight")) writeSizeValue("canvasHeight", Number((l.height / snapshot.resolution * cmPerInch).toFixed(2)));
    el("bleedGuideState").textContent = snapshot.bleedGuideCount ? "已创建 " + snapshot.bleedGuideCount + " 条" : "尚未创建";
    updateBleedPreview();
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

// 编辑保护：轮询 refresh() 每 1.2 秒跑一次，会把数值框重写成文档当前值。
// 真机上用户敲的数字就是这样被冲掉的（「输一个马上还原」就是它）。
// 规则：聚焦中的框不回写；用户编辑过（dirty）的框，在文档真的变化
// （撤销 / 确认修改成功，两种都会让快照签名变化）之前也不回写。
const sizeDirty = {};
let sizeFocus = null;

function readSizeValue(field) {
  return valueText(el(field)).trim();
}

function writeSizeValue(field, text) {
  renderChars(el(field), String(text), false);
  clearSelection(el(field));
}

// 与 bleed 编辑同样的「自绘无光标，首键替换」规则；有蓝色选中时敲键 = 整个替换。
function onSizeKeydown(field, event) {
  const key = event.key;
  const valueEl = el(field);
  if (key === "Enter") { event.preventDefault(); clearSelection(valueEl); el(field).blur(); return; }
  if (key === "Escape") {
    // Esc = 放弃这次编辑：清掉编辑标记、交还焦点，再让 refresh() 用文档当前值还原显示。
    event.preventDefault();
    sizeDirty[field] = false;
    clearSelection(valueEl);
    if (sizeFocus === field) sizeFocus = null;
    el(field).blur();
    refresh(false);
    return;
  }
  if (key === "Backspace") {
    event.preventDefault();
    if (hasSelection(valueEl)) { clearSelection(valueEl); renderChars(valueEl, "0", true); sizeDirty[field] = true; return; }
    const text = readSizeValue(field);
    renderChars(valueEl, text.slice(0, -1) || "0", true);
    sizeDirty[field] = true;
    return;
  }
  const isDigit = typeof key === "string" && key.length === 1 && key >= "0" && key <= "9";
  if (isDigit || key === ".") {
    event.preventDefault();
    const current = readSizeValue(field);
    let next;
    // 「本次编辑的第一个按键替换原值」：自绘控件没有光标，没法做到真正的「全选」。
    // 规则：当前值是默认占位「0」或有蓝色选中就替换，否则追加。简单可预期。
    if (hasSelection(valueEl) || current === "0") {
      next = key === "." ? "0." : key;
    } else {
      if (key === "." && current.indexOf(".") >= 0) return;     // 只允许一个小数点
      next = current + key;
    }
    renderChars(valueEl, next, true);
    clearSelection(valueEl);
    sizeDirty[field] = true;
  }
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
      span.className = "anchor-cell";
      span.setAttribute("data-anchor", id);
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
  const rows = el("anchorGrid").childNodes;
  for (let r = 0; r < rows.length; r++) {
    const rowEl = rows[r];
    if (!rowEl || rowEl.nodeType !== 1) continue;
    const cells = rowEl.childNodes;
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!cell || cell.nodeType !== 1) continue;
      const id = cell.getAttribute("data-anchor");
      cell.className = id === canvasAnchor ? "anchor-cell active" : "anchor-cell";
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
  const widthIn = parsePositive(readSizeValue("imageWidth"));
  const heightIn = parsePositive(readSizeValue("imageHeight"));
  const resolution = parsePositive(readSizeValue("imageResolution"));
  if (widthIn == null || heightIn == null || resolution == null) {
    status("图片大小的宽、高、分辨率都必须是大于 0 的数字。", true);
    return;
  }
  // 锁定时让高度跟随宽度 —— 但反过来写宽从高也可以。这里以「最后改的那一项」为准：
  // 我们没法精确知道谁最后改，所以两个都按宽推：保留宽，高度按比例重算。
  let widthPx = Math.round(widthIn);
  let heightPx = Math.round(heightIn);
  if (imageLock && aspectRatio > 0) {
    heightPx = Math.round(widthPx / aspectRatio);
    writeSizeValue("imageHeight", heightPx);
  }
  disableAll(true);
  status("正在修改图片大小…");
  let failed = false;
  let message;
  try {
    await host.modal(() => host.resizeImage(doc, widthPx, heightPx, resolution), "修改图片大小");
    message = "图片大小已修改为 " + widthPx + " × " + heightPx + " 像素 · " + resolution + " PPI。";
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
  // 画布宽高按「厘米」输入，转成像素：cm * PPI / 2.54。
  // 文档的 PPI 来自上次 refresh() 写入的 lastResolution。
  if (!Number.isFinite(lastResolution) || lastResolution <= 0) {
    status("无法读取文档分辨率，画布大小修改中止。", true);
    return;
  }
  const widthCm = parsePositive(readSizeValue("canvasWidth"));
  const heightCm = parsePositive(readSizeValue("canvasHeight"));
  if (widthCm == null || heightCm == null) {
    status("画布大小的宽、高都必须是大于 0 的数字。", true);
    return;
  }
  const widthPx = Math.round(widthCm * lastResolution / 2.54);
  const heightPx = Math.round(heightCm * lastResolution / 2.54);
  disableAll(true);
  status("正在修改画布大小…");
  let failed = false;
  let message;
  try {
    await host.modal(() => host.resizeCanvas(doc, widthPx, heightPx, ANCHOR_POSITION[canvasAnchor] || "MIDDLECENTER"),
                     "修改画布大小");
    message = "画布大小已修改为 " + widthCm.toFixed(2) + " × " + heightCm.toFixed(2) + " 厘米（锚点：" + ANCHOR_LABEL[canvasAnchor] + "）。";
  } catch (error) {
    console.error(error);
    message = "画布大小修改失败：" + errorText(error);
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
  try { const result = await service.run(mode); message = result.message; failed = !!result.warning; }
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

// 没有内容时整行收起：页脚只在真正有更新消息时才多占一行，
// 平时保持「状态条 + 检查更新/版权」两行，把高度留给上面的功能区。
function setUpdateStatus(message, error) {
  const text = tidyMessage(message);
  const node = el("updateStatus");
  node.textContent = text;
  node.className = (error ? "muted error-text" : "muted") + (text ? "" : " hidden");
}

function releasePage() {
  if (pendingUpdate && pendingUpdate.page) return pendingUpdate.page;
  if (REPO) return "https://github.com/" + REPO + "/releases";
  return "";
}

function showReleaseButton(show) {
  el("openRelease").className = show ? "release-button" : "release-button hidden";
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
  el("installUpdate").className = "primary hidden";
  showReleaseButton(false);
  setDisabled("checkUpdate", true);
  setUpdateStatus("正在检查更新…");
  try {
    const result = await update.check(REPO, VERSION, REF_OVERRIDE, SUBDIR);
    pendingUpdate = result;
    if (result.hasUpdate) {
      // 有新版：同时显示「下载并安装更新」和「打开发布页」，让用户能选一键装或者手动下。
      setUpdateStatus("发现新版本 v" + result.latest + "（当前 v" + result.current + "）。");
      el("installUpdate").className = "primary";
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
    setUpdateStatus(errorText(error), true);
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
    el("installUpdate").className = "primary hidden";
  } catch (error) {
    console.error(error);
    // 常见于插件目录不可写（例如在 C:\Program Files 下）。保留发布页入口让用户手动覆盖。
    setUpdateStatus("更新失败：" + errorText(error) + " 可点下方按钮到发布页手动下载覆盖。", true);
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
    el("footerVersion").textContent = VERSION;
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
      // 自绘数值框没有 change 事件，键盘全部自己接（见 onBleedKeydown）。
      valueEl.addEventListener("keydown", event => onBleedKeydown(field, event));
      // 自绘元素不会自动拿到焦点，点一下补一个 focus()，否则用户点了框打不了字。
      valueEl.addEventListener("click", () => {
        try { valueEl.focus(); } catch (error) { console.error("聚焦出血输入框失败:", error); }
      });
      // 聚焦：容器亮蓝边 + 闪烁光标；失焦：还原容器、清选中、提交未落库的编辑。
      valueEl.addEventListener("focus", () => {
        if (valueEl.parentNode) valueEl.parentNode.className = "bleed-input focused";
        attachCaret(valueEl);
      });
      valueEl.addEventListener("blur", () => {
        if (valueEl.parentNode) valueEl.parentNode.className = "bleed-input";
        detachCaret();
        clearSelection(valueEl);
        commitBleedEdit(field);
      });
      wireValueMouse(valueEl);
      valueEl.setAttribute("title", BLEED_LABELS[field] + "出血：点一下可直接输入数字，双击全选");
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
      valueEl.addEventListener("click", () => {
        try { valueEl.focus(); } catch (error) { console.error("聚焦失败:", field, error); }
      });
      // 焦点跟踪给 refresh() 的编辑保护用：聚焦中的框不能被轮询回写。
      // 聚焦同时补闪烁光标；失焦清光标与选中。
      valueEl.addEventListener("focus", () => { sizeFocus = field; attachCaret(valueEl); });
      valueEl.addEventListener("blur", () => {
        if (sizeFocus === field) sizeFocus = null;
        detachCaret();
        clearSelection(valueEl);
      });
      wireValueMouse(valueEl);
      // 输入框不直接改状态：失焦/回车只把焦点移走，真正的修改走「确认修改」按钮。
      valueEl.setAttribute("title", "点一下可直接输入数字，双击全选，回车或点「确认修改」生效");
    }
    el("applyImageSize").addEventListener("click", () => { void applyImageSize(); });
    el("applyImageSize").title = "按当前值修改图片大小（executeAsModal 包成一步）";
    el("applyCanvasSize").addEventListener("click", () => { void applyCanvasSize(); });
    el("applyCanvasSize").title = "按当前值修改画布大小（executeAsModal 包成一步）";
    el("clear").addEventListener("click", () => { void run("clear"); });
    el("clear").title = "删除当前文档的全部辅助线（含手动添加）";
    el("visibility").addEventListener("click", () => { void toggleVisibility(); });
    el("visibility").title = "隐藏辅助线";
    el("checkUpdate").addEventListener("click", () => { void checkUpdate(); });
    el("installUpdate").addEventListener("click", () => { void installUpdate(); });
    el("openRelease").addEventListener("click", () => { void openRelease(); });
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
