"use strict";

const { originPixels } = require("./origin.js");
const { resizeCanvas: resizeCanvasOperation } = require("./canvas-service.js");
const { convertDocumentColorMode } = require("./color-mode-service.js");

// AnchorPosition 枚举名 → 画布大小 AM 描述符的 horizontal/vertical 枚举值
//（horizontalLocation / verticalLocation：left/center/right × top/center/bottom）。
const CANVAS_ANCHOR = {
  TOPLEFT: ["left", "top"], TOPCENTER: ["center", "top"], TOPRIGHT: ["right", "top"],
  MIDDLELEFT: ["left", "center"], MIDDLECENTER: ["center", "center"], MIDDLERIGHT: ["right", "center"],
  BOTTOMLEFT: ["left", "bottom"], BOTTOMCENTER: ["center", "bottom"], BOTTOMRIGHT: ["right", "bottom"]
};

const GUIDE_POSITION_EPSILON = 0.02;

function validRGB(rgb) {
  return !!rgb && [rgb.r, rgb.g, rgb.b].every(value =>
    Number.isInteger(value) && value >= 0 && value <= 255
  );
}

function hasColor(result, rgb) {
  const created = result && result.new;
  return !!created && created.$GdCA === 0 &&
    created.$GdCR === rgb.r && created.$GdCG === rgb.g && created.$GdCB === rgb.b;
}

function hasDirection(result, direction) {
  const orientation = result && result.new && result.new.orientation;
  return !!orientation && orientation._enum === "orientation" && orientation._value === direction;
}

function hasDocumentTarget(result, docId) {
  const target = result && result.new && result.new._target;
  return Array.isArray(target) && target.length === 2 &&
    target[0] && target[0]._ref === "document" && target[0]._id === docId &&
    target[1] && target[1]._ref === "good" && Number.isInteger(target[1]._index) && target[1]._index > 0;
}

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
    // Photoshop 没有可用的 Guide DOM 颜色字段；以 make 原生返回确认颜色，
    // 再用 DOM 列表核验唯一新增线的文档、方向和坐标。
    async addColoredGuide(doc, direction, coordinate, rgb) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      if (!validRGB(rgb)) throw new Error("参考线颜色必须是 0–255 的整数 RGB 值。");
      if (!["vertical", "horizontal"].includes(direction) || !Number.isFinite(coordinate)) {
        throw new Error("新增参考线的方向或坐标无效。");
      }

      const before = this.listGuides(doc);
      const beforeIds = new Set(before.map(guide => guide.id));
      const descriptor = {
        _obj: "make",
        new: {
          _obj: "good",
          "$GdCA": 0,
          "$GdCR": rgb.r,
          "$GdCG": rgb.g,
          "$GdCB": rgb.b,
          orientation: { _enum: "orientation", _value: direction },
          position: { _unit: "pixelsUnit", _value: coordinate }
        },
        guideTarget: { _enum: "guideTarget", _value: "guideTargetCanvas" },
        _options: { dialogOptions: "silent" }
      };
      const results = await ps.action.batchPlay([descriptor], {});
      if (!results || results.length !== 1 || !results[0] || results[0]._obj === "error") {
        throw new Error("Photoshop 创建彩色参考线失败。");
      }
      const result = results[0];
      const returnedPosition = result.new && result.new.position;
      if (!hasColor(result, rgb) || !hasDirection(result, direction) ||
          !hasDocumentTarget(result, doc.id) || !returnedPosition ||
          returnedPosition._unit !== "distanceUnit" || !Number.isFinite(returnedPosition._value)) {
        throw new Error("Photoshop 返回的参考线颜色或归属信息与请求不符。");
      }
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，已中止参考线创建。");

      const after = this.listGuides(doc);
      const added = after.filter(guide => !beforeIds.has(guide.id));
      const removed = before.some(guide => !after.some(current => current.id === guide.id));
      if (removed || added.length !== 1 || after.length !== before.length + 1) {
        throw new Error("Photoshop 新增参考线数量不符，已中止操作。");
      }
      const created = added[0];
      if (created.docId !== doc.id || created.direction !== direction ||
          Math.abs(created.coordinate - coordinate) > GUIDE_POSITION_EPSILON) {
        throw new Error("Photoshop 新增参考线的位置或文档归属不符。");
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
    async guidesLocked() {
      const results = await ps.action.batchPlay([{
        _obj: "uiInfo", _target: { _ref: "application", _enum: "ordinal", _value: "targetEnum" },
        command: "getCommandEnabled", commandID: 2940
      }], {});
      const state = results && results[0] && results[0].result;
      if (!state || typeof state.checked !== "boolean") throw new Error("无法读取辅助线锁定状态。");
      return state.checked;
    },
    async toggleGuideLock(doc) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const before = await this.guidesLocked();
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const success = await ps.core.performMenuCommand({ commandID: 2940 });
      if (!success) throw new Error("Photoshop 无法切换辅助线锁定状态。");
      const after = await this.guidesLocked();
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新查看锁定状态。");
      if (after === before) throw new Error("辅助线锁定状态未改变。");
      return after;
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
    // 画布大小由独立 service 在一次 suspendHistory 事务中调整、填色和恢复状态。
    // 返回 true = 颜色已应用或无需填色；false = 无背景层，扩展区保持透明。
    async resizeCanvas(doc, width, height, anchor, extensionColor, context) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      return resizeCanvasOperation(ps, doc, width, height, anchor, extensionColor, context);
    },
    findBackgroundLayer(doc) {
      try { if (doc.backgroundLayer) return doc.backgroundLayer; } catch (_) {}
      try {
        for (let i = 0; i < doc.layers.length; i++) {
          if (doc.layers[i].isBackgroundLayer) return doc.layers[i];
        }
      } catch (_) {}
      return null;
    },
    // 前景 / 背景色（画布扩展颜色选「前景 / 背景」时用）：
    // app.foregroundColor 是 SolidColor，rgb 下有 red/green/blue 三个浮点。
    // 读不到就返回 null，调用方自己兜底，绝不因为读颜色卡住改画布。
    getForegroundRGB() {
      try {
        const c = ps.app.foregroundColor;
        return { r: Math.round(c.rgb.red), g: Math.round(c.rgb.green), b: Math.round(c.rgb.blue) };
      } catch (_) { return null; }
    },
    getBackgroundRGB() {
      try {
        const c = ps.app.backgroundColor;
        return { r: Math.round(c.rgb.red), g: Math.round(c.rgb.green), b: Math.round(c.rgb.blue) };
      } catch (_) { return null; }
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
    getBitDepth(doc) {
      const values = ps.constants.BitsPerChannelType || {};
      const depth = doc.bitsPerChannel;
      if (depth == null) return null;
      for (const entry of [["EIGHT", 8], ["SIXTEEN", 16], ["THIRTYTWO", 32]]) {
        if (depth === values[entry[0]] || depth === entry[1]) return entry[1];
      }
      return null;
    },
    // 原生颜色模式转换包进单一历史事务，并核验图层树、文本和位深。
    async changeMode(doc, mode, context) {
      return convertDocumentColorMode(ps, doc, mode, context);
    }
  };
}

module.exports = { createPhotoshopHost };
