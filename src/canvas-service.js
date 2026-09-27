"use strict";

// Photoshop's saved alpha channels are the source of truth for the original
// canvas footprint. The host resizes those channels along with the canvas;
// the expanded area is therefore computed by loading that channel and
// inverting it, without guessing how odd-pixel anchor offsets are rounded.
// Verified in Photoshop 27.9: new alpha pixels remain unselected, across
// nine anchors, odd size differences and mixed expansion/shrink (2026-09-27).

let operationSequence = 0;

const ANCHOR_NAMES = [
  "TOPLEFT", "TOPCENTER", "TOPRIGHT",
  "MIDDLELEFT", "MIDDLECENTER", "MIDDLERIGHT",
  "BOTTOMLEFT", "BOTTOMCENTER", "BOTTOMRIGHT"
];

function makeError(phase, cause) {
  const detail = cause && cause.message ? cause.message : String(cause || "未知错误");
  const error = new Error("画布大小操作在“" + phase + "”阶段失败：" + detail);
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

function validateColor(color) {
  if (color == null) return;
  for (const key of ["r", "g", "b"]) {
    if (!Number.isInteger(color[key]) || color[key] < 0 || color[key] > 255) {
      throw new Error("扩展颜色无效：RGB 分量必须是 0 到 255 的整数。");
    }
  }
}

function validateInputs(ps, doc, width, height, anchor, color, context) {
  assertActiveDocument(ps, doc);
  if (!Number.isFinite(width) || !Number.isInteger(width) || width <= 0 ||
      !Number.isFinite(height) || !Number.isInteger(height) || height <= 0) {
    throw new Error("画布宽高必须是大于 0 的整数像素。");
  }
  if (ANCHOR_NAMES.indexOf(anchor) < 0 ||
      !ps.constants || !ps.constants.AnchorPosition ||
      ps.constants.AnchorPosition[anchor] === undefined) {
    throw new Error("画布锚点无效：" + String(anchor));
  }
  validateColor(color);
  const width0 = Number(doc.width);
  const height0 = Number(doc.height);
  if (!Number.isFinite(width0) || !Number.isFinite(height0) || width0 <= 0 || height0 <= 0) {
    throw new Error("无法读取当前文档的有效画布尺寸。");
  }
  if (!context || !context.hostControl ||
      typeof context.hostControl.suspendHistory !== "function" ||
      typeof context.hostControl.resumeHistory !== "function") {
    throw new Error("缺少 executeAsModal 历史记录上下文，画布修改已中止。");
  }
  return { width0, height0 };
}

function cancelledError() {
  const error = new Error("操作已取消。");
  error.cancelled = true;
  return error;
}

function checkCancelled(context) {
  if (context && context.isCancelled) throw cancelledError();
}

function findBackgroundLayer(doc) {
  try {
    if (doc.backgroundLayer) return doc.backgroundLayer;
  } catch (_) {}
  const visit = layers => {
    if (!layers) return null;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      try { if (layer && layer.isBackgroundLayer) return layer; } catch (_) {}
      try {
        const nested = visit(layer && layer.layers);
        if (nested) return nested;
      } catch (_) {}
    }
    return null;
  };
  return visit(doc.layers);
}

function channelNames(doc) {
  const names = new Set();
  const channels = doc.channels;
  for (let i = 0; i < channels.length; i++) {
    if (channels[i] && typeof channels[i].name === "string") names.add(channels[i].name);
  }
  return names;
}

function uniqueChannelName(doc, label) {
  const existing = channelNames(doc);
  const tick = Date.now().toString(36);
  const sequence = (++operationSequence).toString(36);
  let suffix = 0;
  let name;
  do {
    name = "__codex_canvas_" + label + "_" + tick + "_" + sequence + "_" + suffix++;
  } while (existing.has(name));
  return name;
}

function getChannel(doc, name) {
  let channel = null;
  try {
    channel = doc.channels.getByName(name);
  } catch (_) {}
  if (!channel) throw new Error("Photoshop 未返回临时 Alpha 通道“" + name + "”。");
  return channel;
}

function boundsMatchCanvas(bounds, width, height) {
  if (!bounds) return false;
  return Number(bounds.left) === 0 && Number(bounds.top) === 0 &&
    Number(bounds.right) === width && Number(bounds.bottom) === height;
}

function copyIndexedCollection(collection, label) {
  const length = collection && collection.length;
  if (!Number.isInteger(length) || length < 0) {
    throw new Error("无法读取" + label + "集合长度。");
  }
  const copy = [];
  for (let i = 0; i < length; i++) {
    const item = collection[i];
    if (!item || (typeof item !== "object" && typeof item !== "function")) {
      throw new Error("无法读取" + label + "集合第 " + (i + 1) + " 项。");
    }
    copy.push(item);
  }
  return copy;
}

function checkBatchPlayResult(results) {
  if (!Array.isArray(results) || results.length !== 1 || !results[0]) {
    throw new Error("Photoshop 未返回有效的填色结果。");
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
      ("Photoshop 填色失败（result=" + String(result.result) + "）。"));
    if (result.result === -128 || /cancel|取消/i.test(error.message)) error.cancelled = true;
    throw error;
  }
}

async function fillExpandedArea(ps, color) {
  const results = await ps.action.batchPlay([{
    _obj: "fill",
    using: { _enum: "fillContents", _value: "color" },
    color: { _obj: "RGBColor", red: color.r, grain: color.g, blue: color.b },
    opacity: { _unit: "percentUnit", _value: 100 },
    mode: { _enum: "blendMode", _value: "normal" },
    _options: { dialogOptions: "silent" }
  }], {});
  checkBatchPlayResult(results);
}

function stageError(phase, error) {
  if (error && error.phase) return error;
  return makeError(phase, error);
}

async function restoreTemporaryState(doc, state) {
  const failures = [];
  const attempt = async (phase, callback) => {
    try { await callback(); }
    catch (error) { failures.push(stageError(phase, error)); }
  };

  if (state.selectionSaved) {
    await attempt("恢复原选区", async () => {
      doc.activeChannels = doc.componentChannels;
      const channel = getChannel(doc, state.selectionName);
      await doc.selection.load(channel);
    });
  } else if (state.selectionTouched) {
    await attempt("恢复原选区", async () => { await doc.selection.deselect(); });
  }

  await attempt("切换至复合通道", async () => { doc.activeChannels = doc.componentChannels; });
  for (const name of state.temporaryChannels) {
    await attempt("删除临时 Alpha 通道", async () => {
      let channel = null;
      try { channel = doc.channels.getByName(name); } catch (_) {}
      if (channel) await channel.remove();
    });
  }
  await attempt("恢复原选中图层", async () => { doc.activeLayers = state.activeLayers; });
  await attempt("恢复原活动通道", async () => { doc.activeChannels = state.activeChannels; });

  if (failures.length) {
    const primary = failures[0];
    primary.cleanupErrors = failures.slice(1);
    throw primary;
  }
}

function inspectSelectionState(doc, state, width, height) {
  try {
    state.activeLayers = copyIndexedCollection(doc.activeLayers, "选中图层");
    state.activeChannels = copyIndexedCollection(doc.activeChannels, "活动通道");
    if (!state.activeLayers.length || !state.activeChannels.length || !doc.componentChannels.length) {
      throw new Error("无法完整读取当前选中图层或活动通道。");
    }
  } catch (error) {
    throw stageError("保存图层和通道状态", error);
  }

  try {
    state.originalBounds = doc.selection.bounds;
    state.hadSelection = state.originalBounds !== null && state.originalBounds !== undefined;
  } catch (error) {
    throw stageError("读取原选区", error);
  }
  if (state.hadSelection &&
      (Number(state.originalBounds.left) < 0 || Number(state.originalBounds.top) < 0 ||
       Number(state.originalBounds.right) > width || Number(state.originalBounds.bottom) > height)) {
    const error = new Error("当前选区超出原画布边界；Alpha 通道只能保存画布内像素，为避免选区丢失，已停止修改。");
    error.phase = "检查原选区边界";
    throw error;
  }
}

async function prepareSelectionChannels(doc, state, context, width, height) {
  try { doc.activeChannels = doc.componentChannels; }
  catch (error) { throw stageError("切换至复合通道", error); }
  checkCancelled(context);

  if (state.hadSelection) {
    state.selectionName = uniqueChannelName(doc, "selection");
    state.temporaryChannels.push(state.selectionName);
    try {
      await doc.selection.save(state.selectionName);
      getChannel(doc, state.selectionName);
      state.selectionSaved = true;
    } catch (error) {
      throw stageError("保存原选区", error);
    }
  }

  checkCancelled(context);
  state.canvasName = uniqueChannelName(doc, "canvas");
  state.temporaryChannels.push(state.canvasName);
  try {
    state.selectionTouched = true;
    await doc.selection.selectAll();
    const selectedBounds = doc.selection.bounds;
    const fullCanvas = boundsMatchCanvas(selectedBounds, width, height) && doc.selection.solid === true;
    if (!fullCanvas) {
      throw new Error("Photoshop 当前的“全选”范围不等于完整画布，无法可靠计算扩展区域（画板文档可能出现此情况）。");
    }
    await doc.selection.save(state.canvasName);
    getChannel(doc, state.canvasName);
    await doc.selection.deselect();
  } catch (error) {
    throw stageError("保存原画布范围", error);
  }
}

async function fillExpansion(ps, doc, color, context, canvasChannelName, backgroundLayer) {
  checkCancelled(context);
  try {
    await doc.selection.load(getChannel(doc, canvasChannelName));
    await doc.selection.inverse();
  } catch (error) {
    throw stageError("选中新扩展区域", error);
  }

  checkCancelled(context);
  try {
    doc.activeLayers = [backgroundLayer];
    doc.activeChannels = doc.componentChannels;
  } catch (error) {
    throw stageError("选择背景层和复合通道", error);
  }

  try {
    await fillExpandedArea(ps, color);
  } catch (error) {
    throw stageError("填充扩展区域", error);
  }
  checkCancelled(context);
}

async function resizeCanvas(ps, doc, width, height, anchor, color, context) {
  const dimensions = validateInputs(ps, doc, width, height, anchor, color, context);
  const width0 = dimensions.width0;
  const height0 = dimensions.height0;
  if (width === width0 && height === height0) return true;

  const expands = width > width0 || height > height0;
  const backgroundLayer = expands ? findBackgroundLayer(doc) : null;
  const shouldFill = !!(expands && backgroundLayer && color);
  const transparentExpansion = !!(expands && !backgroundLayer);
  const state = {
    activeLayers: null,
    activeChannels: null,
    selectionName: null,
    canvasName: null,
    hadSelection: false,
    originalBounds: null,
    selectionSaved: false,
    selectionTouched: false,
    temporaryChannels: []
  };
  let suspension = null;
  let phase = "开启历史事务";

  try {
    checkCancelled(context);
    let quickMaskMode;
    try { quickMaskMode = doc.quickMaskMode; }
    catch (error) { throw stageError("检查快速蒙版状态", error); }
    if (quickMaskMode) {
      const error = new Error("快速蒙版模式下无法可靠保存和恢复选区，请先退出快速蒙版后重试。");
      error.phase = "检查快速蒙版状态";
      throw error;
    }
    if (shouldFill) {
      phase = "检查选区和通道状态";
      inspectSelectionState(doc, state, width0, height0);
    }
    phase = "开启历史事务";
    suspension = await context.hostControl.suspendHistory({ documentID: doc.id, name: "修改画布大小" });
    if (!suspension) throw new Error("Photoshop 未返回历史事务标识。");

    if (shouldFill) {
      await prepareSelectionChannels(doc, state, context, width0, height0);
    }

    phase = "调整画布尺寸";
    checkCancelled(context);
    assertActiveDocument(ps, doc);
    try {
      await doc.resizeCanvas(width, height, ps.constants.AnchorPosition[anchor]);
    } catch (error) {
      throw stageError(phase, error);
    }
    if (Number(doc.width) !== width || Number(doc.height) !== height) {
      throw makeError("核对画布尺寸", new Error("实际尺寸为 " + Number(doc.width) + " × " + Number(doc.height) + " px，目标尺寸为 " + width + " × " + height + " px。"));
    }

    if (shouldFill) {
      // No sizing offsets are computed: Photoshop's saved mask encodes them.
      await fillExpansion(ps, doc, color, context, state.canvasName, backgroundLayer);
    }

    if (shouldFill) {
      phase = "恢复原选区、图层和通道";
      await restoreTemporaryState(doc, state);
    }

    checkCancelled(context);
    phase = "提交历史事务";
    await context.hostControl.resumeHistory(suspension, true);
    suspension = null;
    return !transparentExpansion;
  } catch (caught) {
    let error = caught && caught.phase ? caught : stageError(phase, caught);
    if (suspension) {
      if (shouldFill) {
        try { await restoreTemporaryState(doc, state); }
        catch (cleanupError) {
          if (!error.cleanupError) error.cleanupError = cleanupError;
        }
      }
      try {
        await context.hostControl.resumeHistory(suspension, false);
        error.rolledBack = true;
        error.message += " 文档已回滚。";
      } catch (rollbackError) {
        error.rolledBack = false;
        error.rollbackError = rollbackError;
        error.message += " 显式回滚失败，未能确认文档已恢复；请检查 Photoshop 文档状态。";
      }
    }
    throw error;
  }
}

module.exports = { resizeCanvas };
