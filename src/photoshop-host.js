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
    // 出血线整组通道（v1.9.11 新增）：走 PS 自家「新建参考线版面」的 AM 事件
    // （newGuideLayout），把四条出血线当作四条**边距参考线**一次建完，并带上
    // guidesColor 颜色键 —— 这是官方术语表里登记过的 stringID，而且「新建参考线
    // 版面」对话框在真机上确实能建出带色参考线，是唯一有实证的彩色建线通道。
    // targets 是**画布绝对坐标**（未做标尺原点换算的 canvasTargets），顺序与
    // bleedIndices 对齐；origin 是文档标尺原点（建线认领时 DOM 报的是原点相对坐标）。
    // 返回与 targets 对齐的 {id, docId} 数组，任何一条没建成
    // （典型：出血 0 的边，PS 对边距 0 可能不建线）或调用报错 → 返回 null，
    // 由 guide-service 整组退回逐条建线。
    async addBleedGuidesGroup(doc, targets, rgb, origin) {
      if (!targets || !targets.length) return null;
      const ox = origin && Number.isFinite(origin.x) ? origin.x : 0;
      const oy = origin && Number.isFinite(origin.y) ? origin.y : 0;
      const beforeIds = new Set(this.listGuides(doc).map(g => g.id));
      // 归类到四边：按「离哪条边近」判断（不对称出血也能对；正好居中时贴哪边都一样）。
      const margins = {};
      for (const t of targets) {
        if (t.direction === "horizontal") {
          const side = Math.abs(t.coordinate) <= Math.abs(doc.height - t.coordinate) ? "top" : "bottom";
          margins[side] = { _unit: "pixelsUnit", _value: t.coordinate };
        } else {
          const side = Math.abs(t.coordinate) <= Math.abs(doc.width - t.coordinate) ? "left" : "right";
          margins[side] = { _unit: "pixelsUnit", _value: t.coordinate };
        }
      }
      if (Object.keys(margins).length !== targets.length) return null;
      try {
        await ps.action.batchPlay([{
          _obj: "newGuideLayout",
          presetKind: { _enum: "presetKindType", _value: "presetKindCustom" },
          guideLayout: {
            _obj: "guideLayout",
            marginTop: margins.top,
            marginLeft: margins.left,
            marginBottom: margins.bottom,
            marginRight: margins.right,
            guidesColor: { _obj: "RGBColor", red: rgb.r, grain: rgb.g, blue: rgb.b }
          },
          guideTarget: { _enum: "guideTarget", _value: "guideTargetCanvas" },
          replace: false,
          _options: { dialogOptions: "dontDisplay" }
        }], {});
      } catch (error) {
        return null;
      }
      // 逐条认领：方向 + 坐标（按标尺原点换算成 DOM 报告的相对坐标）+ 新 ID，
      // 缺任何一条整组放弃（不搞半新半旧）。
      const after = this.listGuides(doc);
      const claimed = new Set();
      const result = [];
      for (const t of targets) {
        const expected = t.coordinate - (t.direction === "vertical" ? ox : oy);
        const created = after.find(g =>
          g.direction === t.direction && Math.abs(g.coordinate - expected) <= 0.1
          && !beforeIds.has(g.id) && !claimed.has(g.id));
        if (!created || !Number.isInteger(created.id) || created.docId !== doc.id) return null;
        claimed.add(created.id);
        result.push({ id: created.id, docId: created.docId });
      }
      return result;
    },
    // 调起 PS 自带拾色器（v1.9.11，老大要求色块点了要弹窗）：走「设置前景色 +
    // 弹出该命令的对话框」通道 —— set Frgc 的命令 UI 就是拾色器，
    // batchPlay 的 dialogOptions: "display" 会让它显示出来。
    // 用当前颜色做起点；确定后读回新前景色，再把前景色**恢复原样**（拾色器
    // 只是借道，不能真改用户的前景色）。取消返回 null。
    async showColorPicker(startRGB) {
      const original = this.getForegroundRGB();
      const colorDesc = {
        _obj: "set",
        _target: [{ _ref: "Clr ", _property: "Frgc" }],
        to: { _obj: "RGBColor", red: startRGB.r, grain: startRGB.g, blue: startRGB.b },
        _options: { dialogOptions: "display" }
      };
      const restore = original
        ? [{ _obj: "set", _target: [{ _ref: "Clr ", _property: "Frgc" }],
             to: { _obj: "RGBColor", red: original.r, grain: original.g, blue: original.b },
             _options: { dialogOptions: "dontDisplay" } }]
        : [];
      let picked = null;
      try {
        await ps.core.executeAsModal(async () => {
          await ps.action.batchPlay([colorDesc], {});
          // 确定后前景色 = 所选颜色，**趁恢复之前**读回来（finally 里就还原了）。
          picked = this.getForegroundRGB();
        }, { commandName: "选择颜色", timeOut: 1 });
      } catch (error) {
        return null;   // 用户取消（或 PS 不让弹）→ 保持原样
      } finally {
        if (restore.length) {
          try { await ps.action.batchPlay(restore, {}); } catch (_) {}
        }
      }
      return picked;
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
