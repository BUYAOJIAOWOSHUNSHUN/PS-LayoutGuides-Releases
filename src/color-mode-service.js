"use strict";

const MODE_CLASSES = {
  RGB: "RGBColorMode",
  CMYK: "CMYKColorMode"
};

function makeError(phase, cause) {
  const detail = cause && cause.message ? cause.message : String(cause || "未知错误");
  const error = new Error("颜色模式转换在“" + phase + "”阶段失败：" + detail);
  error.phase = phase;
  error.cause = cause;
  if (cause && cause.cancelled) error.cancelled = true;
  return error;
}

function assertActiveDocument(ps, doc) {
  if (!ps || !ps.app || !doc || !Number.isInteger(doc.id)) {
    throw new Error("当前 Photoshop 文档信息无效。");
  }
  if (!ps.app.documents || ps.app.documents.length < 1 ||
      !ps.app.activeDocument || ps.app.activeDocument.id !== doc.id) {
    throw new Error("活动文档已改变，请重新点击操作。");
  }
}

function validateContext(context) {
  if (!context || typeof context.isCancelled !== "boolean" || !context.hostControl ||
      typeof context.hostControl.suspendHistory !== "function" ||
      typeof context.hostControl.resumeHistory !== "function") {
    throw new Error("缺少有效的 executeAsModal 历史记录上下文，颜色模式转换已中止。");
  }
}

function checkCancelled(context) {
  if (context.isCancelled) {
    const error = new Error("操作已取消。");
    error.cancelled = true;
    throw error;
  }
}

function normalizeMode(value) {
  const mode = String(value == null ? "" : value).toUpperCase();
  if (mode.indexOf("CMYK") >= 0) return "CMYK";
  if (mode.indexOf("RGB") >= 0) return "RGB";
  return mode || "UNKNOWN";
}

function bitDepthRank(value, constants) {
  const enumValues = constants && constants.BitsPerChannelType;
  const names = { ONE: 1, EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 };
  if (enumValues) {
    for (const name of Object.keys(names)) {
      if (value === enumValues[name]) return names[name];
    }
  }
  if (typeof value === "number" && (value === 1 || value === 8 || value === 16 || value === 32)) return value;
  const text = String(value == null ? "" : value).toUpperCase();
  if (text.indexOf("THIRTYTWO") >= 0 || text.indexOf("32") >= 0) return 32;
  if (text.indexOf("SIXTEEN") >= 0 || text.indexOf("16") >= 0) return 16;
  if (text.indexOf("EIGHT") >= 0 || text.indexOf("8") >= 0) return 8;
  if (text.indexOf("ONE") >= 0 || /(^|\D)1(\D|$)/.test(text)) return 1;
  return null;
}

function readBitDepth(doc, constants) {
  let value;
  try { value = doc.bitsPerChannel; }
  catch (error) { throw new Error("无法读取文档位深：" + (error.message || String(error))); }
  const rank = bitDepthRank(value, constants);
  if (rank == null) throw new Error("无法识别当前文档位深，已停止转换以避免降低位深。");
  return { value, rank };
}

function isKind(kind, enumValue, name) {
  if (enumValue !== undefined && kind === enumValue) return true;
  return String(kind).toUpperCase().replace(/[^A-Z0-9]/g, "").indexOf(name) >= 0;
}

function indexedItems(collection, label) {
  const length = collection && collection.length;
  if (!Number.isInteger(length) || length < 0) throw new Error("无法读取" + label + "集合长度。");
  const items = [];
  for (let i = 0; i < length; i++) {
    const item = collection[i];
    if (!item || (typeof item !== "object" && typeof item !== "function")) {
      throw new Error("无法读取" + label + "集合第 " + (i + 1) + " 项。");
    }
    items.push(item);
  }
  return items;
}

function snapshotLayerTree(doc, constants) {
  const layerKinds = constants && constants.LayerKind || {};
  const rows = [];
  const ids = new Set();

  function visit(collection, parentId, path) {
    const items = indexedItems(collection, "图层");
    for (let index = 0; index < items.length; index++) {
      const layer = items[index];
      let id, kind, name;
      try {
        id = layer.id;
        kind = layer.kind;
        name = layer.name;
      } catch (error) {
        throw new Error("无法读取图层身份、类型或名称：" + (error.message || String(error)));
      }
      if (!Number.isInteger(id) || kind == null || typeof name !== "string") {
        throw new Error("图层缺少有效 ID、类型或名称。");
      }
      if (ids.has(id)) throw new Error("图层 ID 重复，无法安全核对图层结构。");
      ids.add(id);

      const kindText = String(kind);
      const row = {
        id,
        name,
        kind: kindText,
        parentId,
        path: path.concat(index),
        order: index
      };
      if (isKind(kind, layerKinds.TEXT, "TEXT")) {
        let contents;
        try { contents = layer.textItem && layer.textItem.contents; }
        catch (error) { throw new Error("无法读取文本图层内容：" + (error.message || String(error))); }
        if (typeof contents !== "string") throw new Error("无法核验文本图层内容。");
        row.textContents = contents;
      }

      const isGroup = isKind(kind, layerKinds.GROUP, "GROUP");
      if (isGroup) {
        const children = layer.layers;
        row.childCount = indexedItems(children, "分组图层").length;
      }
      // kind=SMARTOBJECT is recorded as a distinct layer kind so an implicit
      // rasterization is detected even when Photoshop happens to retain IDs.
      rows.push(row);
      if (isGroup) visit(layer.layers, id, path.concat(index));
    }
  }

  visit(doc.layers, null, []);
  return rows;
}

function captureState(doc, constants) {
  let mode;
  try { mode = normalizeMode(doc.mode); }
  catch (error) { throw new Error("无法读取文档颜色模式：" + (error.message || String(error))); }
  return {
    mode,
    bitsPerChannel: readBitDepth(doc, constants),
    layers: snapshotLayerTree(doc, constants)
  };
}

function compareLayers(before, after) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const afterIds = new Set(after.map(layer => layer.id));
  const missing = before.find(layer => !afterIds.has(layer.id));
  if (missing) {
    const name = missing.name || ("ID " + missing.id);
    throw new Error("当前模式转换无法保留图层“" + name + "”，操作已中止。");
  }
  if (before.length !== after.length) {
    throw new Error("当前模式转换新增了图层，操作已中止。");
  }
  const afterById = new Map(after.map(layer => [layer.id, layer]));
  for (const original of before) {
    const current = afterById.get(original.id);
    if (original.kind !== current.kind) {
      throw new Error("图层“" + original.name + "”的类型发生改变，检测到栅格化或类型转换，操作已中止。");
    }
    if (original.name !== current.name) {
      throw new Error("图层“" + original.name + "”的名称发生改变，操作已中止。");
    }
    if (Object.prototype.hasOwnProperty.call(original, "textContents") &&
        original.textContents !== current.textContents) {
      throw new Error("文本图层“" + original.name + "”的文字内容发生改变，操作已中止。");
    }
    if (original.parentId !== current.parentId || original.order !== current.order ||
        original.childCount !== current.childCount || JSON.stringify(original.path) !== JSON.stringify(current.path)) {
      throw new Error("图层“" + original.name + "”的顺序或分组层次发生改变，操作已中止。");
    }
  }
}

function checkBatchPlayResult(results) {
  if (!Array.isArray(results) || results.length !== 1 || !results[0]) {
    throw new Error("Photoshop 未返回有效的颜色模式转换结果。");
  }
  const result = results[0];
  if (result._obj === "error") {
    const message = result.message || result.error || result.result || "Photoshop 返回错误。";
    const error = new Error(String(message));
    if (result.result === -128 || /cancel|取消/i.test(String(message))) error.cancelled = true;
    throw error;
  }
  if (result.result === false ||
      (typeof result.result === "number" && result.result !== 0) ||
      (typeof result.result === "string" && /^(error|failed|cancelled|canceled)$/i.test(result.result))) {
    const error = new Error(result.message || result.error ||
      ("Photoshop 颜色模式转换失败（result=" + String(result.result) + "）。"));
    if (result.result === -128 || /cancel|取消/i.test(error.message)) error.cancelled = true;
    throw error;
  }
}

async function convertDocumentColorMode(ps, doc, mode, context) {
  if (!Object.prototype.hasOwnProperty.call(MODE_CLASSES, mode)) {
    throw new Error("仅支持转换为 RGB 或 CMYK 模式。");
  }
  assertActiveDocument(ps, doc);
  validateContext(context);
  checkCancelled(context);

  const before = captureState(doc, ps.constants);
  if (before.mode === mode) return { changed: false, mode };

  let suspension = null;
  let phase = "开启历史事务";
  try {
    checkCancelled(context);
    assertActiveDocument(ps, doc);
    suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name: "转换颜色模式" });
    if (!suspension) throw new Error("Photoshop 未返回历史事务标识。");

    phase = "转换颜色模式";
    checkCancelled(context);
    assertActiveDocument(ps, doc);
    const results = await ps.action.batchPlay([{
      _obj: "convertMode",
      to: { _class: MODE_CLASSES[mode] },
      flatten: false,
      rasterize: false,
      merge: false,
      _options: { dialogOptions: "silent" }
    }], {});
    checkBatchPlayResult(results);

    phase = "核对转换结果";
    checkCancelled(context);
    assertActiveDocument(ps, doc);
    const after = captureState(doc, ps.constants);
    if (after.mode !== mode) throw new Error("Photoshop 返回后文档仍为 " + after.mode + " 模式。");
    if (after.bitsPerChannel.rank < before.bitsPerChannel.rank) {
      throw new Error("转换降低了文档位深，已拒绝提交。");
    }
    compareLayers(before.layers, after.layers);

    phase = "提交历史事务";
    checkCancelled(context);
    await context.hostControl.resumeHistory(suspension, true);
    suspension = null;
    return { changed: true, mode, bitsPerChannel: after.bitsPerChannel.value };
  } catch (caught) {
    const error = caught && caught.phase ? caught : makeError(phase, caught);
    if (suspension) {
      try {
        await context.hostControl.resumeHistory(suspension, false);
        suspension = null;
        const restored = captureState(doc, ps.constants);
        compareLayers(before.layers, restored.layers);
        if (restored.mode !== before.mode) throw new Error("回滚后的颜色模式与转换前不一致。");
        if (restored.bitsPerChannel.rank !== before.bitsPerChannel.rank) throw new Error("回滚后的文档位深与转换前不一致。");
        error.rolledBack = true;
        error.message += " 文档已回滚并核验恢复。";
      } catch (rollbackError) {
        error.rolledBack = false;
        error.rollbackError = rollbackError;
        error.message += " 显式回滚失败或未能核验完整恢复，请检查 Photoshop 文档状态。";
      }
    }
    throw error;
  }
}

module.exports = { convertDocumentColorMode };
