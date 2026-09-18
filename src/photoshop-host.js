"use strict";

const { originPixels } = require("./origin.js");

function createPhotoshopHost(ps) {
  function active() {
    if (!ps.app.documents.length) return null;
    return ps.app.activeDocument;
  }
  function listGuides(doc) {
    const result = [];
    for (let i = 0; i < doc.guides.length; i++) {
      const guide = doc.guides[i];
      const direction = guide.direction === ps.constants.Direction.VERTICAL ? "vertical"
        : guide.direction === ps.constants.Direction.HORIZONTAL ? "horizontal" : null;
      if (!direction || !Number.isInteger(guide.id) || guide.docId !== doc.id || !Number.isFinite(guide.coordinate)) {
        throw new Error("Photoshop 返回了无法核验的辅助线，已停止操作。");
      }
      result.push({ id: guide.id, docId: guide.docId, direction, coordinate: guide.coordinate });
    }
    return result;
  }
  return {
    active,
    openIds() {
      const ids = [];
      for (let i = 0; i < ps.app.documents.length; i++) ids.push(ps.app.documents[i].id);
      return ids;
    },
    listGuides,
    async readOrigin(doc) {
      const keys = ["rulerOriginH", "rulerOriginV"];
      const results = await ps.action.batchPlay(keys.map(key => ({
        _obj: "get",
        _target: [{ _ref: "property", _property: key }, { _ref: "document", _id: doc.id }],
        _options: { dialogOptions: "silent" }
      })), {});
      if (!results || results.length !== 2 || results.some(r => !r || r._obj === "error")) {
        throw new Error("无法读取当前文档的标尺原点。");
      }
      return { x: originPixels(results[0][keys[0]]), y: originPixels(results[1][keys[1]]) };
    },
    async addGuide(doc, target) {
      const direction = target.direction === "vertical" ? ps.constants.Direction.VERTICAL : ps.constants.Direction.HORIZONTAL;
      const guide = await doc.guides.add(direction, target.coordinate);
      if (!guide || !Number.isInteger(guide.id) || guide.docId !== doc.id) {
        throw new Error("新增辅助线未返回有效归属信息。");
      }
      return { id: guide.id, docId: guide.docId };
    },
    // 彩色参考线：UXP 的 Guide DOM 对象没有颜色字段，但底层（Action Manager）的
    // 建线事件支持随线指定 RGB 颜色——「新建参考线」对话框能选颜色就是证据。
    // 这里走 batchPlay 直接建带色参考线；发现不支持就记住并退回普通建线（只丢颜色不丢功能）。
    // 建完后用「方向 + 坐标 + 新 ID」在辅助线集合里认领回这条线，归属核验和普通建线一样严。
    coloredGuidesSupported: true,
    async addColoredGuide(doc, direction, coordinate, rgb) {
      if (this.coloredGuidesSupported === false) {
        return this.addGuide(doc, { direction, coordinate });
      }
      const beforeIds = new Set(this.listGuides(doc).map(g => g.id));
      try {
        await ps.action.batchPlay([{
          _obj: "make",
          new: {
            _obj: "guide",
            position: { _unit: "pixelsUnit", _value: coordinate },
            orientation: { _enum: "orientation", _value: direction },
            color: { _obj: "RGBColor", red: rgb.r, grain: rgb.g, blue: rgb.b }
          },
          _options: { dialogOptions: "dontDisplay" }
        }], {});
      } catch (error) {
        this.coloredGuidesSupported = false;
        return this.addGuide(doc, { direction, coordinate });
      }
      const created = this.listGuides(doc).find(g =>
        g.direction === direction && Math.abs(g.coordinate - coordinate) <= 0.1 && !beforeIds.has(g.id));
      if (!created || !Number.isInteger(created.id) || created.docId !== doc.id) {
        throw new Error("彩色辅助线创建后无法核验归属。");
      }
      return { id: created.id, docId: created.docId };
    },
    async deleteGuide(doc, id) {
      // Resolve again after every deletion; collection indices change.
      for (let i = 0; i < doc.guides.length; i++) {
        const guide = doc.guides[i];
        if (guide.id === id && guide.docId === doc.id) {
          await guide.delete();
          return;
        }
      }
    },
    async guideVisibility() {
      const results = await ps.action.batchPlay([{
        _obj: "uiInfo", _target: { _ref: "application", _enum: "ordinal", _value: "targetEnum" },
        command: "getCommandEnabled", commandID: 3503
      }], {});
      const state = results && results[0] && results[0].result;
      if (!state || typeof state.checked !== "boolean") throw new Error("无法读取辅助线显示状态。");
      return state.checked;
    },
    async ensureGuidesVisible(doc) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      if (!await this.guideVisibility()) await this.toggleGuides(doc);
    },
    async toggleGuides(doc) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const before = await this.guideVisibility();
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const success = await ps.core.performMenuCommand({ commandID: 3503 });
      if (!success) throw new Error("Photoshop 无法切换辅助线显示状态。");
      const after = await this.guideVisibility();
      if (after === before) throw new Error("辅助线显示状态未改变。");
      return after;
    },
    modal(fn, name) { return ps.core.executeAsModal(fn, { commandName: name, timeOut: 1 }); },
    // 图片大小：宽/高/分辨率都是像素 + PPI。ResampleMethod.BICUBIC 是 PS 默认。
    async resizeImage(doc, width, height, resolution) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const ResampleMethod = ps.constants.ResampleMethod;
      await doc.resizeImage(width, height, resolution, ResampleMethod.BICUBIC);
    },
    // 画布大小：宽/高是像素，anchor 是 TOPLEFT / TOPCENTER / ... / BOTTOMRIGHT 中的一个。
    async resizeCanvas(doc, width, height, anchor) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const AnchorPosition = ps.constants.AnchorPosition;
      await doc.resizeCanvas(width, height, AnchorPosition[anchor]);
    },
    // 文档颜色模式：Document.mode 在不同 UXP 版本可能返回数字枚举或字符串，
    // 统一转大写后按关键词归类成 RGB / CMYK / GRAY / 其它原文。
    getMode(doc) {
      const raw = String(doc.mode == null ? "" : doc.mode).toUpperCase();
      if (raw.indexOf("CMYK") >= 0) return "CMYK";
      if (raw.indexOf("RGB") >= 0) return "RGB";
      if (raw.indexOf("GRAY") >= 0 || raw.indexOf("BITMAP") >= 0) return "GRAY";
      return raw || "UNKNOWN";
    },
    // 转换文档颜色模式（RGB / CMYK）。枚举表拿不到时直接传字符串兜底。
    async changeMode(doc, mode) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const table = (ps.constants && ps.constants.ChangeMode) || {};
      await doc.changeMode(table[mode] || mode);
    }
  };
}

module.exports = { createPhotoshopHost };
