"use strict";

const { calculateLayout, guideTargets, bleedTargets, millimetresToPixels } = require("./calculator.js");
const { relativeCoordinate } = require("./origin.js");
const { findBrand } = require("./brands.js");

const EPSILON = 0.02;
const MODES = ["update", "logo", "endorsement", "bleed", "clear"];
const MODE_NAMES = {
  update: "更新版心辅助线",
  logo: "更新 LOGO 高度辅助线",
  endorsement: "更新背书标志辅助线",
  bleed: "更新出血辅助线",
  clear: "清除全部辅助线"
};

function samePosition(a, b) {
  return a.direction === b.direction && Math.abs(a.coordinate - b.coordinate) <= EPSILON;
}

function matchesTargets(guides, targets) {
  const remaining = guides.slice();
  for (const target of targets) {
    const index = remaining.findIndex(g => samePosition(g, target));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function errorText(error) {
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error.message === "string" && error.message.trim()) return error.message;
  try { const value = JSON.stringify(error); if (value && value !== "{}" && value !== "null") return value; } catch (_) {}
  return "Photoshop 未返回详细错误信息";
}

// 当前文档已有的辅助线组合，用于「已是最新」提示文案。
function describeCurrent(includeLOGO, includeEndorsement, includeBleed) {
  const parts = [];
  if (includeLOGO) parts.push("LOGO 高度线");
  if (includeEndorsement) parts.push("背书参考线");
  if (includeBleed) parts.push("出血线");
  return parts.length ? "版心与 " + parts.join("、") + "已是最新。" : "四条版心辅助线已是最新。";
}

class GuideService {
  constructor(host) {
    this.host = host;
    // Keep all committed IDs for this document lifetime, including absent IDs.
    // Undo/redo may bring back an earlier generation. Never persist across reload.
    this.ledger = new Map();
    this.logoLedger = new Map();
    this.endorsementLedger = new Map();
    this.bleedLedger = new Map();
    this.brandId = "yijing";
    this.bleedMM = { top: 3, right: 3, bottom: 3, left: 3 };
    this.busy = false;
  }

  get brand() {
    return findBrand(this.brandId);
  }

  // 切换品牌标准。切到新品牌时，出血默认值一并跟随该品牌的标准。
  // 标准未录入（available === false）的品牌一律拒绝，避免后续按空规则计算。
  setBrand(id) {
    const brand = findBrand(id);
    if (!brand.available) return false;
    if (brand.id === this.brandId) return false;
    this.brandId = brand.id;
    if (brand.bleedDefault) this.bleedMM = { ...brand.bleedDefault };
    return true;
  }

  setBleed(values) {
    this.bleedMM = { ...this.bleedMM, ...values };
  }

  prune() {
    const open = new Set(this.host.openIds());
    for (const id of this.ledger.keys()) if (!open.has(id)) {
      this.ledger.delete(id);
      this.logoLedger.delete(id);
      this.endorsementLedger.delete(id);
      this.bleedLedger.delete(id);
    }
  }

  snapshot() {
    this.prune();
    const doc = this.host.active();
    if (!doc) return null;
    const ids = this.ledger.get(doc.id) || new Set();
    const guides = this.host.listGuides(doc);
    const brand = this.brand;
    return {
      id: doc.id, name: doc.title || doc.name || "未命名文档", resolution: doc.resolution,
      brandId: brand.id, brandName: brand.name,
      layout: calculateLayout(doc.width, doc.height, brand),
      ownedCount: guides.filter(g => ids.has(g.id)).length,
      logoGuideCount: guides.filter(g => (this.logoLedger.get(doc.id) || new Set()).has(g.id)).length,
      endorsementGuideCount: guides.filter(g => (this.endorsementLedger.get(doc.id) || new Set()).has(g.id)).length,
      bleedGuideCount: guides.filter(g => (this.bleedLedger.get(doc.id) || new Set()).has(g.id)).length,
      otherCount: guides.filter(g => !ids.has(g.id)).length
    };
  }

  async showResult(doc, message) {
    try { await this.host.ensureGuidesVisible(doc); return { message }; }
    catch (error) {
      return { warning: true, message: message + " 但自动显示失败：" + errorText(error) + "。可用 Photoshop 的‘视图 > 显示 > 参考线’显示。" };
    }
  }

  async run(mode) {
    if (!MODES.includes(mode)) throw new Error("未知操作。");
    if (this.busy) return { skipped: true, message: "正在处理，请稍候。" };
    this.busy = true;
    try {
      this.prune();
      const requested = this.host.active();
      if (!requested) throw new Error("请先打开一个 Photoshop 文档。");
      const expectedId = requested.id;
      const name = MODE_NAMES[mode];
      const brand = this.brand;
      const bleedMM = { ...this.bleedMM };
      return await this.host.modal(async context => {
        const doc = this.host.active();
        if (!doc || doc.id !== expectedId) throw new Error("活动文档已改变，请重新点击操作。");
        const layout = calculateLayout(doc.width, doc.height, brand);
        const bleedPx = {
          top: millimetresToPixels(bleedMM.top, doc.resolution),
          right: millimetresToPixels(bleedMM.right, doc.resolution),
          bottom: millimetresToPixels(bleedMM.bottom, doc.resolution),
          left: millimetresToPixels(bleedMM.left, doc.resolution)
        };
        const known = this.ledger.get(doc.id) || new Set();
        const before = this.host.listGuides(doc);
        const owned = before.filter(g => known.has(g.id));
        const others = mode === "clear" ? [] : before.filter(g => !known.has(g.id));
        const logoIds = this.logoLedger.get(doc.id) || new Set();
        const endorsementIds = this.endorsementLedger.get(doc.id) || new Set();
        const bleedIds = this.bleedLedger.get(doc.id) || new Set();
        // 已建过的分组在重建其它分组时一并保留，避免互相覆盖。
        const includeLOGO = mode !== "clear" && (mode === "logo" || owned.some(g => logoIds.has(g.id)));
        const includeEndorsement = mode !== "clear" && (mode === "endorsement" || owned.some(g => endorsementIds.has(g.id)));
        const includeBleed = mode !== "clear" && (mode === "bleed" || owned.some(g => bleedIds.has(g.id)));
        const canvasTargets = mode === "clear" ? [] : guideTargets(layout);
        // Keep content margins independent from the LOGO's local safety inset.
        const logoIndices = [];
        if (includeLOGO) {
          logoIndices.push(canvasTargets.length);
          canvasTargets.push({ direction: "horizontal", coordinate: layout.logoSafeInset + layout.logoHeight });
          if (layout.logoSafeInset > layout.marginX + EPSILON) {
            logoIndices.push(canvasTargets.length);
            canvasTargets.push({ direction: "horizontal", coordinate: layout.logoSafeInset });
            logoIndices.push(canvasTargets.length);
            canvasTargets.push({ direction: "vertical", coordinate: layout.logoSafeInset });
          }
        }
        const endorsementIndex = canvasTargets.length;
        if (includeEndorsement) canvasTargets.push({ direction: "horizontal", coordinate: layout.height - layout.marginX - layout.endorsementHeight });
        // 出血线画在画布外，四条各自独立，允许上下左右数值不同。
        const bleedIndices = [];
        if (includeBleed) {
          for (const target of bleedTargets(layout, bleedPx)) {
            bleedIndices.push(canvasTargets.length);
            canvasTargets.push(target);
          }
        }
        const origin = mode !== "clear" ? await this.host.readOrigin(doc) : null;
        const targets = canvasTargets.map(t => ({
          direction: t.direction, coordinate: relativeCoordinate(t, origin)
        }));
        if (mode !== "clear" && matchesTargets(owned, targets)) {
          return await this.showResult(doc, describeCurrent(includeLOGO, includeEndorsement, includeBleed));
        }
        if (mode === "clear" && !before.length) {
          return { message: "当前文档没有辅助线。" };
        }
        const checkCancelled = () => { if (context.isCancelled) throw new Error("操作已取消。"); };
        checkCancelled();
        const suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name });
        const created = [];
        try {
          for (const guide of (mode === "clear" ? before : owned)) {
            checkCancelled();
            await this.host.deleteGuide(doc, guide.id);
          }
          for (const target of targets) {
            checkCancelled();
            const guide = await this.host.addGuide(doc, target);
            if (before.some(g => g.id === guide.id) || created.includes(guide.id)) {
              throw new Error("新增辅助线 ID 不唯一，已中止更新。");
            }
            created.push(guide.id);
          }
          const after = this.host.listGuides(doc);
          const added = after.filter(g => created.includes(g.id));
          if (after.length !== others.length + targets.length || !matchesTargets(added, targets) ||
              others.some(g => !after.some(a => a.id === g.id && samePosition(a, g)))) {
            throw new Error("辅助线数量、位置或用户辅助线核验失败。");
          }
          checkCancelled();
          await context.hostControl.resumeHistory(suspension, true);
        } catch (error) {
          // If cancellation prevents explicit rollback, rethrowing also asks
          // executeAsModal to cancel any still-suspended history automatically.
          try { await context.hostControl.resumeHistory(suspension, false); }
          catch (rollbackError) { console.error("History rollback:", rollbackError); }
          throw error;
        }
        for (const id of created) known.add(id);
        this.ledger.set(doc.id, known);
        if (includeLOGO) for (const index of logoIndices) logoIds.add(created[index]);
        this.logoLedger.set(doc.id, logoIds);
        if (includeEndorsement) endorsementIds.add(created[endorsementIndex]);
        this.endorsementLedger.set(doc.id, endorsementIds);
        if (includeBleed) for (const index of bleedIndices) bleedIds.add(created[index]);
        this.bleedLedger.set(doc.id, bleedIds);
        if (mode === "clear") return { message: "已清除当前文档的全部辅助线。" };
        return await this.showResult(doc, buildMessage(mode, includeLOGO, includeEndorsement, includeBleed, logoIndices));
      }, name);
    } finally {
      this.busy = false;
    }
  }
}

function buildMessage(mode, includeLOGO, includeEndorsement, includeBleed, logoIndices) {
  if (mode === "bleed") return "已更新出血辅助线（画布外扩，与版心线同色）。";
  const parts = [];
  if (includeLOGO) parts.push("LOGO 高度线" + (logoIndices.length > 1 ? "（含顶部/左侧安全线）" : ""));
  if (includeEndorsement) parts.push("背书参考线（0.3H，另需核对正文大小）");
  if (includeBleed) parts.push("出血线");
  return parts.length ? "已更新版心与 " + parts.join("、") + "。" : "已更新四条版心辅助线。";
}

module.exports = { GuideService, matchesTargets, errorText };
