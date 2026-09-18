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
    }
  };
}

module.exports = { createPhotoshopHost };
