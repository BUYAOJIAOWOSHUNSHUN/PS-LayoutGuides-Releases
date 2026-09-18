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
    // 画布大小（v1.9.15 重写为「DOM 改尺寸 + 扩展区域手动补色」，彻底告别弹窗）：
    // AM 的 canvasSize / resizeCanvas / CnvS 三个事件形态在真机上都不老实 ——
    // v1.9.12 补了 dialogOptions 不弹错误框了，但参数仍被判定「不完整」，
    // PS 照样弹原生「画布大小」对话框（dontDisplay 挡不住「需要补充参数」的场景）。
    // 所以现在改用 DOM 的 doc.resizeCanvas（v1.8.x 一路在用，必生效、从不弹窗），
    // 扩展颜色靠**事后补色**：按锚点算出新增区域（上下左右最多四条），
    // 在**背景层**上逐块填充所选颜色 —— 与 PS「画布扩展颜色」的原生语义一致
    //（原生也只填背景层；没有背景层时扩展区域本来就是透明的，跳过补色）。
    // 返回 true = 颜色已应用（或本次用不上）；false = 画布改了但颜色没应用上。
    async resizeCanvas(doc, width, height, anchor, extensionColor) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const w0 = Number(doc.width);
      const h0 = Number(doc.height);
      const AnchorPosition = ps.constants.AnchorPosition;
      await doc.resizeCanvas(width, height, AnchorPosition[anchor] || AnchorPosition.MIDDLECENTER);
      if (!extensionColor) return true;
      const w1 = Number(doc.width);
      const h1 = Number(doc.height);
      if (!Number.isFinite(w1) || !Number.isFinite(h1)) return false;
      // 锚点 → 旧画布在新画布里的偏移（LEFT/RIGHT/TOP/BOTTOM 优先于 CENTER 匹配）。
      const dx = anchor.indexOf("LEFT") >= 0 ? 0 : anchor.indexOf("RIGHT") >= 0 ? w1 - w0 : (w1 - w0) / 2;
      const dy = anchor.indexOf("TOP") >= 0 ? 0 : anchor.indexOf("BOTTOM") >= 0 ? h1 - h0 : (h1 - h0) / 2;
      // 扩展区域 = 新画布 − 旧画布位置，拆成上下左右四条（可能只有部分存在）。
      const rects = [];
      if (dy > 0.5) rects.push({ left: 0, top: 0, right: w1, bottom: dy });
      if (dy + h0 < h1 - 0.5) rects.push({ left: 0, top: dy + h0, right: w1, bottom: h1 });
      const midTop = Math.max(0, dy);
      const midBottom = Math.min(h1, dy + h0);
      if (dx > 0.5 && midBottom - midTop > 0.5) rects.push({ left: 0, top: midTop, right: dx, bottom: midBottom });
      if (dx + w0 < w1 - 0.5 && midBottom - midTop > 0.5) rects.push({ left: dx + w0, top: midTop, right: w1, bottom: midBottom });
      if (!rects.length) return true;   // 画布缩小或尺寸不变：没有新增区域，颜色用不上
      // 补色目标是**背景层**（与 PS 原生语义一致）；找不到背景层就跳过补色。
      const bg = this.findBackgroundLayer(doc);
      if (!bg) return false;
      const previousIds = doc.activeLayers.map(l => l.id);
      doc.activeLayers = [bg];
      try {
        for (const r of rects) {
          await ps.action.batchPlay([
            { _obj: "setd", _target: [{ _ref: "Chnl", _property: "fsel" }],
              to: { _obj: "rectangle",
                    top: { _unit: "pixelsUnit", _value: r.top },
                    left: { _unit: "pixelsUnit", _value: r.left },
                    bottom: { _unit: "pixelsUnit", _value: r.bottom },
                    right: { _unit: "pixelsUnit", _value: r.right } },
              _options: { dialogOptions: "dontDisplay" } },
            { _obj: "Fl  ",
              Usng: { _obj: "RGBColor", red: extensionColor.r, grain: extensionColor.g, blue: extensionColor.b },
              Opct: { _unit: "percentUnit", _value: 100 },
              Md: { _enum: "blendMode", _value: "normal" },
              _options: { dialogOptions: "dontDisplay" } }
          ], {});
        }
      } finally {
        try {
          await ps.action.batchPlay([{ _obj: "Dslc", _target: [{ _ref: "Chnl", _property: "fsel" }],
            _options: { dialogOptions: "dontDisplay" } }], {});
        } catch (_) {}
        // 恢复用户原本的激活图层。
        const restore = [];
        for (let i = 0; i < doc.layers.length; i++) {
          if (previousIds.indexOf(doc.layers[i].id) >= 0) restore.push(doc.layers[i]);
        }
        if (restore.length) doc.activeLayers = restore;
      }
      return true;
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
    // 转换文档颜色模式（RGB / CMYK）。枚举表拿不到时直接传字符串兜底。
    async changeMode(doc, mode) {
      if (!active() || active().id !== doc.id) throw new Error("活动文档已改变，请重新点击操作。");
      const table = (ps.constants && ps.constants.ChangeMode) || {};
      await doc.changeMode(table[mode] || mode);
    }
  };
}

module.exports = { createPhotoshopHost };
