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
const ALL_BUTTONS = MODE_BUTTONS.concat(["clear", "visibility"]);

let currentTab = "screen";
let bleedLocked = false;
let bleedUnit = "mm";
let visibilityReading = false;
let timer = null;
let initialized = false;
let lastSignature = null;
let lastResolution = null;
let pendingUpdate = null;
let registered = false;

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

function renderBleedInputs() {
  for (const field of BLEED_FIELDS) {
    el("bleed-" + field).value = trim(toDisplay(service.bleedMM[field]));
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
  const raw = String(el("bleed-" + field).value).trim();
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
    el("bleed-" + field).value = trim(display);
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
      el("documentName").textContent = "请打开 Photoshop 文档";
      el("dimensions").textContent = "以整个文档画布为基准";
      ["orientation", "ratio", "marginX", "logoHeight", "logoRule", "marginRule", "logoSafety", "endorsementHeight", "endorsementRule", "bleedGuideState"].forEach(id => { el(id).textContent = "—"; });
      updateBleedPreview();
      if (changed || explicit) status("当前没有打开的文档。");
      return;
    }
    const l = snapshot.layout;
    lastResolution = snapshot.resolution;
    el("documentName").textContent = snapshot.name;
    el("dimensions").textContent = px(l.width) + " × " + px(l.height) + " · " + format(snapshot.resolution) + " PPI";
    el("orientation").textContent = { landscape: "横版", portrait: "竖版", square: "正方形" }[l.orientation];
    el("ratio").textContent = Number(l.ratio.toFixed(6)) + " : 1";
    el("marginX").textContent = px(l.marginX);
    el("marginRule").textContent = snapshot.brandName + " · 短边 ÷ 20";
    el("logoHeight").textContent = px(l.logoHeight);
    el("logoSafety").textContent = "顶部 / 左侧安全距离 ≥ " + px(l.logoSafeInset);
    el("endorsementHeight").textContent = px(l.endorsementHeight);
    el("endorsementRule").textContent = "参考 0.3H · 上限 " + px(l.endorsementMaxHeight) + "，需结合正文";
    el("logoRule").textContent = "短边 × " + format(l.logoPercent * 100) + "% · " + format(l.logoXMultiple) + "X";
    el("bleedGuideState").textContent = snapshot.bleedGuideCount ? "已创建 " + snapshot.bleedGuideCount + " 条" : "尚未创建";
    updateBleedPreview();
    if (changed || explicit) {
      status(snapshot.ownedCount ? "已就绪 · 当前文档已有 " + snapshot.ownedCount + " 条插件辅助线。" : "已就绪 · 可创建版心、LOGO 高度线或出血线。");
    }
    if (snapshot) void syncVisibility(snapshot.id);
  } catch (error) {
    disableAll(true);
    status("读取失败：" + errorText(error), true);
  }
}

/* ---------- 执行 ---------- */

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
    showReleaseButton(true);
    if (result.hasUpdate) {
      setUpdateStatus("发现新版本 v" + result.latest + "（当前 v" + result.current + "）。");
      el("installUpdate").className = "primary";
    } else {
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
    el("headerVersion").textContent = VERSION;
    el("versionText").textContent = VERSION;
    // 初始不留提示文字：页脚只有点「检查更新」时才展开这一行。
    setUpdateStatus(REPO ? "" : "更新源待配置");
    // 品牌菜单与出血输入依赖图片和输入框组件，单独兜错，
    // 避免它们出问题时连累辅助线按钮整体不可用。
    try { buildBrandRow(); } catch (error) { console.error("品牌菜单初始化失败:", error); }
    try { renderBleedInputs(); } catch (error) { console.error("出血输入初始化失败:", error); }
    bindAction(el("tabScreen"), () => setTab("screen"));
    bindAction(el("tabPrint"), () => setTab("print"));
    bindAction(el("lock"), toggleLock);
    bindAction(el("unitMM"), () => setUnit("mm"));
    bindAction(el("unitCM"), () => setUnit("cm"));
    for (const field of BLEED_FIELDS) {
      el("bleed-" + field).addEventListener("change", event => onBleedInput(field, event.target.value));
      el("bleed-" + field).addEventListener("keydown", event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          stepBleed(field, event.key === "ArrowUp" ? 1 : -1);
        }
      });
      bindAction(el("step-up-" + field), () => stepBleed(field, 1));
      bindAction(el("step-down-" + field), () => stepBleed(field, -1));
    }
    for (const id of MODE_BUTTONS) el(id).addEventListener("click", () => { void run(id); });
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
