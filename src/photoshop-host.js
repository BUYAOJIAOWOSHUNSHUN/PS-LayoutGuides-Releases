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
    // 只是官方没把键名写进文档。
    // v1.9.8 单键（"color"）真机无效；v1.9.10 五键探测 + 回读否决，真机仍然全退回默认色。
    // v1.9.11 调整策略：**回读只用来「正向确认」，不再当否决依据** ——
    // v1.9.10 有一种可能：某个键其实生效了，但参考线描述符回读不出颜色，
    // 被误判成「键被无视」删掉换键，最后全部落空。现在改成：
    // 按可能性排序逐个试，**第一个不报错且建出线的键直接采用**（回读确认成功就记住优先）。
    coloredGuidesSupported: true,
    coloredVariantIndex: -1,
    async addColoredGuide(doc, direction, coordinate, rgb) {
      if (this.coloredGuidesSupported === false) {
        return this.addGuide(doc, { direction, coordinate });
      }
      const colorObj = { _obj: "RGBColor", red: rgb.r, grain: rgb.g, blue: rgb.b };
      // 候选键 × 挂载位置（对象内 / make 顶层）。顺序 = 可能性排序：
      // "Clr "（charID）是 AM 里所有带色对象的标准键；"guidesColor" 是 PS 官方
      // 术语表（PIStringTerminology.h）里登记的 stringID；"color" 是 v1.9.8 老方案。
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
        // 回读确认只做正向记录：确认成功 = 实锤记住这个键；确认不出 = 也采用
        // （不再删线换键 —— v1.9.10 的教训，见上）。
        const verdict = await this.readGuideColor(doc, created.id);
        if (verdict === true) this.coloredVariantIndex = index;
        else if (this.coloredVariantIndex < 0) this.coloredVariantIndex = index;
        return { id: created.id, docId: created.docId };
      }
      // 全部键都报错：退回普通建线（只丢颜色不丢功能），由 guide-service 补提示。
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
    // 画布大小（v1.9.13 重写为**多事件形态探测 + 改完核对实际尺寸**）：
    // v1.9.9~1.9.12 用的 canvasSize 事件在真机上**静默无效**（不报错、不改尺寸），
    // 弹原生对话框是漏了 dialogOptions（v1.9.12 已修），但「改不动」还在。
    // 事件名在 AM 里有几个候选：resizeCanvas（stringID，与 UXP DOM 方法同名）、
    // canvasSize（v1.9.9 起用的，真机无效）、CnvS（charID，ScriptListener 直录）。
    // 与其猜，不如**每试一个形态就立刻核对文档实际尺寸**：真把尺寸改对了才算数
    // 并记住；全不行还有 DOM 的 doc.resizeCanvas 兜底（v1.8.x 一路在用，稳）。
    // 返回 true = 扩展颜色一起应用了；false = 画布改了但颜色没应用上。
    canvasFormIndex: -1,
    canvasDescriptors(form, width, height, hv, extensionColor) {
      // form 0/1：stringID 事件 + stringID 键；form 2：charID 事件 + charID 键
      //（ScriptListener 直录形态：CnvS / Wdth / Hght / Hrzn / Vrtc / HrzL / VrtL）。
      if (form === 2) {
        const desc = {
          _obj: "CnvS",
          Wdth: { _unit: "#Pxl", _value: width },
          Hght: { _unit: "#Pxl", _value: height },
          Hrzn: { _enum: "HrzL", _value: hv[0] },
          Vrtc: { _enum: "VrtL", _value: hv[1] },
          _options: { dialogOptions: "dontDisplay" }
        };
        if (extensionColor) {
          desc.canvasExtensionColorType = { _enum: "canvasExtensionColorType", _value: "Clr " };
          desc.canvasExtensionColor = {
            _obj: "RGBC",
            "Rd  ": extensionColor.r, "Grn ": extensionColor.g, "Bl  ": extensionColor.b
          };
        }
        return desc;
      }
      const desc = {
        _obj: form === 0 ? "resizeCanvas" : "canvasSize",
        width: { _unit: "pixelsUnit", _value: width },
        height: { _unit: "pixelsUnit", _value: height },
        horizontal: { _enum: "horizontalLocation", _value: hv[0] },
        vertical: { _enum: "verticalLocation", _value: hv[1] },
        _options: { dialogOptions: "dontDisplay" }
      };
      if (extensionColor) {
        desc.canvasExtensionColorType = { _enum: "canvasExtensionColorType", _value: "Clr " };
        desc.canvasExtensionColor = {
          _obj: "RGBColor",
          red: extensionColor.r, grain: extensionColor.g, blue: extensionColor.b
        };
      }
      return desc;
    },
    canvasMatches(doc, width, height) {
      // 改完立刻核对实际尺寸（±1px 容差）。doc.width 在不同环境可能是数字或
      // 带valueOf的对象，统一 Number() 归一。
      try {
        const w = Number(doc.width);
        const h = Number(doc.height);
        return Number.isFinite(w) && Number.isFinite(h)
          && Math.abs(w - width) <= 1 && Math.abs(h - height) <= 1;
      } catch (_) {
        return false;
      }
    },
    async resizeCanvas(doc, width, height, anchor, extensionColor) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const hv = CANVAS_ANCHOR[anchor] || CANVAS_ANCHOR.MIDDLECENTER;
      // 尝试顺序：记住的胜出形态最优先；每个形态先带色（如需要）再裸试，
      // 每次都核对实际尺寸，真改动了才算数。
      const order = [];
      if (this.canvasFormIndex >= 0) order.push(this.canvasFormIndex);
      for (const f of [0, 1, 2]) {
        if (order.indexOf(f) < 0) order.push(f);
      }
      for (const form of order) {
        const variants = extensionColor ? [extensionColor, null] : [null];
        for (const color of variants) {
          try {
            await ps.action.batchPlay([this.canvasDescriptors(form, width, height, hv, color)], {});
          } catch (_) {
            continue;   // 这个形态 PS 不认，静默试下一个
          }
          if (!this.canvasMatches(doc, width, height)) continue;   // 没真改 → 无效
          this.canvasFormIndex = form;
          return color !== null;   // true = 带色成功；false = 裸成功（颜色丢了）
        }
      }
      // 全部 AM 形态无效：DOM 兜底（无扩展颜色，但一定生效）。
      const AnchorPosition = ps.constants.AnchorPosition;
      await doc.resizeCanvas(width, height, AnchorPosition[anchor]);
      return false;
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
