"use strict";

const { originPixels } = require("./origin.js");

// AnchorPosition 枚举名 → 画布大小 AM 描述符的 horizontal/vertical 枚举值
//（horizontalLocation / verticalLocation：left/center/right × top/center/bottom）。
const CANVAS_ANCHOR = {
  TOPLEFT: ["left", "top"], TOPCENTER: ["center", "top"], TOPRIGHT: ["right", "top"],
  MIDDLELEFT: ["left", "center"], MIDDLECENTER: ["center", "center"], MIDDLERIGHT: ["right", "center"],
  BOTTOMLEFT: ["left", "bottom"], BOTTOMCENTER: ["center", "bottom"], BOTTOMRIGHT: ["right", "bottom"]
};

// 彩色参考线的候选颜色键（按可能性排序，运行时逐个探测）：
// 0. "Clr "（charID）+ RGBC 对象 —— Action Manager 里所有「带颜色的对象」
//    （纯色层、投影颜色、内容层……）几乎都用这个键，是最可能的写法；
// 1. "color"（stringID）—— v1.9.8 的老方案，真机已证明颜色不生效（但建线不报错）；
// 2. "guidesColor" —— PS 官方术语表（PIStringTerminology.h）里登记过的 stringID；
// 3/4. 同样的键放在 make 描述符顶层（万一颜色挂在事件层而不是 guide 对象层）。
const GUIDE_COLOR_KEYS = ["Clr ", "color", "guidesColor"];

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
    // 彩色参考线：UXP 的 Guide DOM 对象没有颜色字段，但 PS 自带「新建参考线 /
    // 新建参考线版面」对话框都能随线选颜色，说明底层数据模型支持单线带色，
    // 只是官方没把键名写进文档。v1.9.8 只试了一种键（"color" → RGBColor），
    // 真机上线出来了但颜色没生效。v1.9.9 改成**多方案探测**：
    // 按可能性排序逐个试，哪个键 PS 认就用哪个并记住（本次会话内不再重复探测）；
    // 建完尽量回读这条线的描述符来验证颜色真的写上了 —— 回读得到的描述符里
    // 有颜色键才算实锤，描述符里干干净净（连方向和坐标都读到了）就删掉换下一个键；
    // 回读本身不支持（PS 报错）时按「没报错就收货」处理，不再折腾。
    coloredGuidesSupported: true,
    coloredVariantIndex: -1,
    async addColoredGuide(doc, direction, coordinate, rgb) {
      if (this.coloredGuidesSupported === false) {
        return this.addGuide(doc, { direction, coordinate });
      }
      const colorObj = { _obj: "RGBColor", red: rgb.r, grain: rgb.g, blue: rgb.b };
      // 探测顺序：记住的胜出键最优先，其余按 GUIDE_COLOR_KEYS 的顺序跟在后面。
      const order = [];
      if (this.coloredVariantIndex >= 0) order.push(this.coloredVariantIndex);
      for (let i = 0; i < GUIDE_COLOR_KEYS.length * 2; i++) {
        if (order.indexOf(i) < 0) order.push(i);
      }
      for (const index of order) {
        const key = GUIDE_COLOR_KEYS[index % GUIDE_COLOR_KEYS.length];
        const topLevel = index >= GUIDE_COLOR_KEYS.length;
        const beforeIds = new Set(this.listGuides(doc).map(g => g.id));
        try {
          await ps.action.batchPlay([this.coloredGuideDescriptor(direction, coordinate, key, colorObj, topLevel)], {});
        } catch (error) {
          continue;   // 这个键 PS 直接不认（报错），试下一个
        }
        const created = this.listGuides(doc).find(g =>
          g.direction === direction && Math.abs(g.coordinate - coordinate) <= 0.1 && !beforeIds.has(g.id));
        if (!created || !Number.isInteger(created.id) || created.docId !== doc.id) continue;
        const verdict = await this.readGuideColor(doc, created.id);
        if (verdict === false) {
          // 线建上了但颜色被无视 —— 删掉这条，换下一个键。
          try { await this.deleteGuide(doc, created.id); } catch (_) {}
          continue;
        }
        this.coloredVariantIndex = index;
        return { id: created.id, docId: created.docId };
      }
      // 全部键都不行：退回普通建线（只丢颜色不丢功能），由 guide-service 补提示。
      this.coloredGuidesSupported = false;
      return this.addGuide(doc, { direction, coordinate });
    },
    // 生成「建带色参考线」的 batchPlay 描述符。topLevel=true 时颜色挂在 make 顶层，
    // 否则挂在 guide 对象里（与位置、方向平级）。
    coloredGuideDescriptor(direction, coordinate, key, colorObj, topLevel) {
      const guideObj = {
        _obj: "guide",
        position: { _unit: "pixelsUnit", _value: coordinate },
        orientation: { _enum: "orientation", _value: direction }
      };
      const desc = { _obj: "make", new: guideObj, _options: { dialogOptions: "dontDisplay" } };
      if (topLevel) desc[key] = colorObj;
      else guideObj[key] = colorObj;
      return desc;
    },
    // 回读一条参考线的描述符，看颜色键在不在：
    //   true  = 描述符里确实带颜色键（实锤成功）
    //   false = 描述符读到了、连方向坐标都全，就是没有颜色键（实锤失败）
    //   null  = 回读不了 / 结果不可信（无法验证，按成功收货）
    async readGuideColor(doc, guideId) {
      let index = -1;
      for (let i = 0; i < doc.guides.length; i++) {
        if (doc.guides[i].id === guideId) { index = i; break; }
      }
      if (index < 0) return null;
      let result;
      try {
        // _index 是 1 基的（AM 引用约定），集合序号要 +1。
        result = await ps.action.batchPlay([{
          _obj: "get",
          _target: [{ _ref: "guide", _index: index + 1 },
                    { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
          _options: { dialogOptions: "silent" }
        }], {});
      } catch (_) {
        return null;
      }
      const desc = result && result[0];
      if (!desc || desc._obj === "error" || desc.Ornt === undefined) return null;
      for (const key of GUIDE_COLOR_KEYS) {
        if (desc[key] !== undefined) return true;
      }
      return false;
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
    // 画布大小（v1.9.9 起走 batchPlay，为了带上「画布扩展颜色」）：
    // DOM 的 doc.resizeCanvas 没有颜色参数。PS「画布大小」对话框的扩展颜色在
    // Action Manager 里是 canvasExtensionColorType 枚举（"Clr " = 自定颜色）+
    // canvasExtensionColor（RGBC 对象），已从 ScriptListener 记录核实（CnvS 事件）；
    // 锚点用 horizontal / vertical 两个枚举（left/center/right × top/center/bottom），
    // 与 AnchorPosition 的九个取值一一对应（CANVAS_ANCHOR 表）。
    // 返回 true = 扩展颜色一起应用了；false = 画布改了但颜色没应用上（见回退）。
    async resizeCanvas(doc, width, height, anchor, extensionColor) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const hv = CANVAS_ANCHOR[anchor] || CANVAS_ANCHOR.MIDDLECENTER;
      const desc = {
        _obj: "canvasSize",
        relative: false,
        width: { _unit: "pixelsUnit", _value: width },
        height: { _unit: "pixelsUnit", _value: height },
        horizontal: { _enum: "horizontalLocation", _value: hv[0] },
        vertical: { _enum: "verticalLocation", _value: hv[1] }
      };
      if (extensionColor) {
        desc.canvasExtensionColorType = { _enum: "canvasExtensionColorType", _value: "Clr " };
        desc.canvasExtensionColor = {
          _obj: "RGBColor",
          red: extensionColor.r, grain: extensionColor.g, blue: extensionColor.b
        };
      }
      try {
        await ps.action.batchPlay([desc], {});
        return true;
      } catch (error) {
        // 带颜色失败（例如文档没有背景层时扩展颜色本就不可用）→ 先退一次
        // 不带颜色的 AM；再失败退 DOM 的 resizeCanvas。保证「改画布」优先于颜色。
        if (extensionColor) {
          const plain = Object.assign({}, desc);
          delete plain.canvasExtensionColorType;
          delete plain.canvasExtensionColor;
          try {
            await ps.action.batchPlay([plain], {});
            return false;
          } catch (_) {}
        }
        const AnchorPosition = ps.constants.AnchorPosition;
        await doc.resizeCanvas(width, height, AnchorPosition[anchor]);
        return false;
      }
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
    // 转换文档颜色模式（RGB / CMYK）。枚举表拿不到时直接传字符串兜底。
    async changeMode(doc, mode) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const table = (ps.constants && ps.constants.ChangeMode) || {};
      await doc.changeMode(table[mode] || mode);
    }
  };
}

module.exports = { createPhotoshopHost };
