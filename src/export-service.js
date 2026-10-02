"use strict";

const FORMATS = Object.freeze({
  jpg: { extension: ".jpg" },
  jpeg: { extension: ".jpg" },
  png: { extension: ".png" },
  psd: { extension: ".psd" },
  tiff: { extension: ".tif" },
  tif: { extension: ".tif" }
});

function makeError(message, code, cause) {
  const error = new Error(message);
  if (code) error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function checkCancelled(context) {
  if (context && context.isCancelled) {
    const error = makeError("导出已取消。", "EXPORT_CANCELLED");
    error.cancelled = true;
    throw error;
  }
}

const QUICK_PNG_COMMAND_ID = 3444;
const QUICK_PNG_TITLES = new Set(["快速导出为png", "quickexportaspng"]);

function normalizeMenuTitle(title) {
  return String(title == null ? "" : title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}

function readMenuTitle(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") return value[0];
  return null;
}

function readMenuAvailability(value) {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "boolean") return value[0];
  return null;
}

function readQuickExportResult(value) {
  if (typeof value === "boolean") return { known: true, available: value, userCancelled: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { known: false };
  if (value.userCancelled === true) return { known: true, available: false, userCancelled: true };
  if (typeof value.available !== "boolean" ||
      (value.userCancelled !== undefined && typeof value.userCancelled !== "boolean")) {
    return { known: false };
  }
  return { known: true, available: value.available, userCancelled: false };
}

function validateQuickExportDocument(ps, doc) {
  if (!ps || !ps.app || !doc || !Number.isInteger(doc.id)) {
    throw makeError("当前 Photoshop 文档信息无效。", "EXPORT_INVALID_DOCUMENT");
  }
  const documents = listDocuments(ps);
  if (!documents.some(item => item.id === doc.id)) {
    throw makeError("要导出的文档已关闭或无法访问。", "EXPORT_DOCUMENT_CLOSED");
  }
  if (!ps.app.activeDocument || ps.app.activeDocument.id !== doc.id) {
    throw makeError("活动文档已改变，请重新选择要导出的文档。", "EXPORT_DOCUMENT_CHANGED");
  }
}

function isCancellationError(error, context) {
  if (context && context.isCancelled) return true;
  if (!error) return false;
  if (error.cancelled === true || error.canceled === true) return true;
  return /cancel(?:led|ed)?|取消/i.test(String(error.message || ""));
}

function cancellationError(cause) {
  const error = makeError("快速导出 PNG 已取消。", "EXPORT_CANCELLED", cause);
  error.cancelled = true;
  return error;
}

function exportCancellationError(cause) {
  const error = makeError("导出已取消。", "EXPORT_CANCELLED", cause);
  error.cancelled = true;
  return error;
}

/**
 * Invokes Photoshop's native File > Export > Quick Export as PNG command.
 * Photoshop owns the destination prompt and output preferences for this action.
 */
async function exportQuickPNG(ps, doc, executionContext) {
  // Quick Export owns its native interaction. Callers invoke this outside a
  // plugin executeAsModal scope and let Photoshop manage its native dialog.
  checkCancelled(executionContext);
  validateQuickExportDocument(ps, doc);

  const core = ps.core;
  if (!core || typeof core.getMenuCommandTitle !== "function" ||
      typeof core.getMenuCommandState !== "function" ||
      typeof core.performMenuCommand !== "function") {
    throw makeError("当前 Photoshop 环境不支持检查并调用快速导出为 PNG 菜单命令。", "EXPORT_QUICK_PNG_UNAVAILABLE");
  }

  let titleResult;
  try {
    titleResult = await core.getMenuCommandTitle({ commandID: QUICK_PNG_COMMAND_ID });
  } catch (error) {
    if (isCancellationError(error, executionContext)) throw cancellationError(error);
    throw makeError("无法读取 Photoshop 快速导出为 PNG 命令标题。", "EXPORT_QUICK_PNG_UNAVAILABLE", error);
  }
  const title = readMenuTitle(titleResult);
  if (title == null) {
    throw makeError("Photoshop 返回了无法识别的快速导出菜单标题。", "EXPORT_QUICK_PNG_INVALID_RESPONSE");
  }
  if (!QUICK_PNG_TITLES.has(normalizeMenuTitle(title))) {
    throw makeError(
      "Photoshop 当前快速导出菜单不是 PNG，或菜单命令与已验证命令 ID 不匹配。请在 Photoshop 的导出首选项中确认快速导出格式为 PNG 后重试；插件不会更改该设置。",
      "EXPORT_QUICK_PNG_COMMAND_MISMATCH"
    );
  }

  checkCancelled(executionContext);
  validateQuickExportDocument(ps, doc);

  let availableResult;
  try {
    availableResult = await core.getMenuCommandState({ commandID: QUICK_PNG_COMMAND_ID });
  } catch (error) {
    if (isCancellationError(error, executionContext)) throw cancellationError(error);
    throw makeError("无法检查 Photoshop 快速导出为 PNG 命令状态。", "EXPORT_QUICK_PNG_UNAVAILABLE", error);
  }
  const available = readMenuAvailability(availableResult);
  if (available == null) {
    throw makeError("Photoshop 返回了无法识别的快速导出命令状态。", "EXPORT_QUICK_PNG_INVALID_RESPONSE");
  }
  if (!available) {
    checkCancelled(executionContext);
    throw makeError("Photoshop 当前无法使用快速导出为 PNG 命令。", "EXPORT_QUICK_PNG_UNAVAILABLE");
  }

  checkCancelled(executionContext);
  validateQuickExportDocument(ps, doc);

  let invokeResult;
  try {
    invokeResult = await core.performMenuCommand({ commandID: QUICK_PNG_COMMAND_ID });
  } catch (error) {
    if (isCancellationError(error, executionContext)) throw cancellationError(error);
    throw makeError("Photoshop 快速导出为 PNG 命令执行失败。", "EXPORT_QUICK_PNG_FAILED", error);
  }
  checkCancelled(executionContext);
  const invocation = readQuickExportResult(invokeResult);
  if (invocation.userCancelled) throw cancellationError(invokeResult);
  if (!invocation.known) {
    throw makeError("Photoshop 返回了无法识别的快速导出结果，未报告成功。", "EXPORT_QUICK_PNG_INVALID_RESPONSE");
  }
  if (!invocation.available) {
    throw makeError(
      "Photoshop 未确认快速导出为 PNG 命令调用成功；该 API 无法说明是命令不可用还是原生导出未完成。",
      "EXPORT_QUICK_PNG_NOT_CONFIRMED"
    );
  }

  return {
    format: "png",
    commandID: QUICK_PNG_COMMAND_ID,
    documentId: doc.id,
    documentName: String(doc.name || ""),
    invoked: true
  };
}

function listDocuments(ps) {
  const collection = ps && ps.app && ps.app.documents;
  const length = collection && collection.length;
  if (!Number.isInteger(length) || length < 0) {
    throw makeError("无法读取 Photoshop 文档列表。", "EXPORT_DOCUMENT_LIST");
  }
  const docs = [];
  for (let i = 0; i < length; i++) {
    const item = collection[i];
    if (item && Number.isInteger(item.id)) docs.push(item);
  }
  return docs;
}

function normalizeMode(value, constants) {
  if (value == null) return "UNKNOWN";
  const modes = constants && constants.DocumentMode;
  if (modes) {
    for (const name of ["RGB", "CMYK", "GRAYSCALE", "INDEXEDCOLOR", "BITMAP", "LAB", "DUOTONE", "MULTICHANNEL"]) {
      if (value === modes[name]) return name;
    }
  }
  const text = String(value == null ? "" : value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (text.indexOf("CMYK") >= 0) return "CMYK";
  if (text.indexOf("RGB") >= 0) return "RGB";
  if (text.indexOf("GRAY") >= 0 || text.indexOf("GREY") >= 0) return "GRAYSCALE";
  if (text.indexOf("INDEXED") >= 0) return "INDEXEDCOLOR";
  if (text.indexOf("BITMAP") >= 0) return "BITMAP";
  if (text.indexOf("LAB") >= 0) return "LAB";
  if (text.indexOf("DUOTONE") >= 0) return "DUOTONE";
  if (text.indexOf("MULTICHANNEL") >= 0) return "MULTICHANNEL";
  return "UNKNOWN";
}

function bitDepthRank(value, constants) {
  if (value == null) return null;
  const enums = constants && constants.BitsPerChannelType;
  const names = { ONE: 1, EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 };
  if (enums) {
    for (const name of Object.keys(names)) {
      if (value === enums[name]) return names[name];
    }
  }
  if (value === 1 || value === 8 || value === 16 || value === 32) return value;
  const text = String(value == null ? "" : value).toUpperCase();
  if (text.indexOf("THIRTYTWO") >= 0 || /(^|\D)32(\D|$)/.test(text)) return 32;
  if (text.indexOf("SIXTEEN") >= 0 || /(^|\D)16(\D|$)/.test(text)) return 16;
  if (text.indexOf("EIGHT") >= 0 || /(^|\D)8(\D|$)/.test(text)) return 8;
  if (text.indexOf("ONE") >= 0 || /(^|\D)1(\D|$)/.test(text)) return 1;
  return null;
}

function readDocumentState(doc, constants) {
  const dimensions = readDocumentDimensions(doc);
  const width = dimensions.width;
  const height = dimensions.height;
  const mode = normalizeMode(doc.mode, constants);
  const bitsPerChannel = bitDepthRank(doc.bitsPerChannel, constants);
  if (mode === "UNKNOWN") {
    throw makeError("无法识别文档颜色模式，已停止导出。", "EXPORT_UNSUPPORTED_MODE");
  }
  if (bitsPerChannel == null) {
    throw makeError("无法识别文档位深，已停止导出。", "EXPORT_UNSUPPORTED_BIT_DEPTH");
  }
  return { width, height, mode, bitsPerChannel };
}

function readDocumentDimensions(doc) {
  const width = Number(doc.width);
  const height = Number(doc.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw makeError("无法读取文档像素尺寸。", "EXPORT_INVALID_SIZE");
  }
  return { width, height };
}

function readNativeSaveState(doc, constants) {
  const dimensions = readDocumentDimensions(doc);
  return {
    width: dimensions.width,
    height: dimensions.height,
    mode: normalizeMode(doc.mode, constants),
    bitsPerChannel: bitDepthRank(doc.bitsPerChannel, constants)
  };
}

function ensureActiveDocument(ps, expectedId) {
  if (!ps.app.activeDocument || ps.app.activeDocument.id !== expectedId) {
    throw makeError("活动文档已改变，请重新选择要导出的文档。", "EXPORT_DOCUMENT_CHANGED");
  }
}

async function saveTiffDocument(ps, doc, file, executionContext, asCopy = true) {
  const action = ps.action;
  if (!action || typeof action.batchPlay !== "function") {
    throw makeError("当前 Photoshop 环境不支持 TIFF 保存命令。", "EXPORT_SAVE_UNAVAILABLE");
  }

  let localFileSystem;
  try {
    localFileSystem = require("uxp").storage.localFileSystem;
  } catch (error) {
    throw makeError("无法访问选定的 TIFF 输出位置。", "EXPORT_SESSION_TOKEN_UNAVAILABLE", error);
  }
  if (!localFileSystem || typeof localFileSystem.createSessionToken !== "function") {
    throw makeError("无法为选定的 TIFF 输出文件建立访问权限。", "EXPORT_SESSION_TOKEN_UNAVAILABLE");
  }

  checkCancelled(executionContext);
  ensureActiveDocument(ps, doc.id);
  let fileToken;
  try {
    fileToken = await localFileSystem.createSessionToken(file);
  } catch (error) {
    throw makeError("无法取得 TIFF 输出文件的访问权限。", "EXPORT_SESSION_TOKEN_FAILED", error);
  }
  checkCancelled(executionContext);
  ensureActiveDocument(ps, doc.id);

  const descriptor = {
    _obj: "save",
    as: { _obj: "TIFF" },
    in: { _path: fileToken, _kind: "local" },
    copy: asCopy,
    _options: { dialogOptions: "dontDisplay" }
  };
  const results = await action.batchPlay([descriptor], {
    synchronousExecution: false
  });
  checkCancelled(executionContext);
  ensureActiveDocument(ps, doc.id);

  const commandResult = Array.isArray(results) ? results[0] : null;
  if (commandResult && commandResult.result === -128) {
    const error = makeError("导出已取消。", "EXPORT_CANCELLED", commandResult);
    error.cancelled = true;
    throw error;
  }
  if (!commandResult || String(commandResult._obj || "").toLowerCase() === "error" ||
      (commandResult.result !== undefined && commandResult.result !== 0)) {
    const message = commandResult && commandResult.message
      ? "Photoshop TIFF 保存失败：" + commandResult.message
      : "Photoshop 未确认 TIFF 保存成功。";
    throw makeError(message, "EXPORT_TIFF_SAVE_FAILED", commandResult || results);
  }
}

function validateMode(format, mode) {
  const jpgModes = ["RGB", "CMYK", "GRAYSCALE"];
  const pngModes = ["RGB", "CMYK", "GRAYSCALE", "INDEXEDCOLOR", "BITMAP"];
  const supported = format === "jpg" ? jpgModes : pngModes;
  if (supported.indexOf(mode) < 0) {
    throw makeError(
      "当前 " + mode + " 颜色模式无法安全地自动导出为 " + format.toUpperCase() + "，请先在 Photoshop 中转换模式。",
      "EXPORT_UNSUPPORTED_MODE"
    );
  }
}

function validateContext(context) {
  const hostControl = context && context.hostControl;
  if (!context || typeof context.isCancelled !== "boolean" || !hostControl ||
      typeof hostControl.registerAutoCloseDocument !== "function" ||
      typeof hostControl.unregisterAutoCloseDocument !== "function") {
    throw makeError("缺少有效的 executeAsModal 上下文。", "EXPORT_MODAL_CONTEXT");
  }
}

function validateInput(ps, doc, format, file, context) {
  if (!ps || !ps.app || !doc || !Number.isInteger(doc.id)) {
    throw makeError("当前 Photoshop 文档信息无效。", "EXPORT_INVALID_DOCUMENT");
  }
  if (!Object.prototype.hasOwnProperty.call(FORMATS, String(format || "").toLowerCase())) {
    throw makeError("仅支持 JPG、PNG、PSD 和 TIFF 格式。", "EXPORT_UNSUPPORTED_FORMAT");
  }
  if (!file) {
    const error = makeError("导出已取消。", "EXPORT_CANCELLED");
    error.cancelled = true;
    throw error;
  }
  if (typeof file !== "object") {
    throw makeError("缺少有效的保存文件，请先调用 getFileForSaving。", "EXPORT_INVALID_FILE");
  }
  validateContext(context);
  if (!ps.app.activeDocument || ps.app.activeDocument.id !== doc.id) {
    throw makeError("活动文档已改变，请重新选择要导出的文档。", "EXPORT_DOCUMENT_CHANGED");
  }
}

async function setCopyMode(copy, ps, targetMode) {
  const modes = ps.constants && ps.constants.ChangeMode;
  const modeValue = modes && modes[targetMode] !== undefined ? modes[targetMode] : targetMode;
  if (typeof copy.changeMode !== "function") {
    throw makeError("当前 Photoshop 环境不支持安全的文档颜色模式转换。", "EXPORT_CONVERSION_UNAVAILABLE");
  }
  await copy.changeMode(modeValue);
  const state = readDocumentState(copy, ps.constants);
  if (state.mode !== targetMode) {
    throw makeError("Photoshop 未将临时副本转换为 " + targetMode + " 模式。", "EXPORT_CONVERSION_FAILED");
  }
}

async function prepareCopy(copy, ps, format, originalState) {
  const constants = ps.constants || {};
  let state = readDocumentState(copy, constants);
  if (state.bitsPerChannel === 32) {
    throw makeError("不支持导出 32 位/通道文档，请先在 Photoshop 中手动转换位深。", "EXPORT_32_BIT_UNSUPPORTED");
  }

  if (format === "jpg" && state.bitsPerChannel !== 8) {
    const bitDepths = constants.BitsPerChannelType;
    if (!bitDepths || bitDepths.EIGHT === undefined) {
      throw makeError("当前 Photoshop 环境不支持安全的位深转换。", "EXPORT_CONVERSION_UNAVAILABLE");
    }
    copy.bitsPerChannel = bitDepths.EIGHT;
    state = readDocumentState(copy, constants);
    if (state.bitsPerChannel !== 8) {
      throw makeError("Photoshop 未将临时副本转换为 8 位/通道。", "EXPORT_CONVERSION_FAILED");
    }
  }

  if (format === "png" && state.mode === "CMYK") {
    await setCopyMode(copy, ps, "RGB");
    state = readDocumentState(copy, constants);
  }

  if (format === "png" && state.bitsPerChannel !== originalState.bitsPerChannel) {
    throw makeError("PNG 导出准备改变了位深；为避免有损导出，已停止保存。", "EXPORT_BIT_DEPTH_CHANGED");
  }

  validateMode(format, state.mode);
  if (state.width !== originalState.width || state.height !== originalState.height) {
    throw makeError("导出准备意外改变了临时副本的像素尺寸，已停止保存。", "EXPORT_SIZE_CHANGED");
  }

  return state;
}

function matchesTemporaryName(doc, temporaryName) {
  if (!temporaryName || !doc) return false;
  try { if (doc.name === temporaryName) return true; } catch (_) { /* keep checking */ }
  try { if (doc.title === temporaryName) return true; } catch (_) { /* keep checking */ }
  return false;
}

async function cleanupTemporaryDocument(ps, originalDoc, existingIds, temporaryId, temporaryName, temporaryRef, executionContext, autoCloseIds) {
  const errors = [];
  let docs = [];
  try {
    docs = listDocuments(ps);
  } catch (error) {
    errors.push(error);
  }

  const temporaryDocs = docs.filter(item => !existingIds.has(item.id) &&
    ((temporaryId != null && item.id === temporaryId) || matchesTemporaryName(item, temporaryName)));
  if (temporaryRef && Number.isInteger(temporaryRef.id) && !existingIds.has(temporaryRef.id) &&
      !temporaryDocs.some(item => item.id === temporaryRef.id)) {
    temporaryDocs.push(temporaryRef);
  }

  // Select the original before closing. Photoshop's closeWithoutSaving may
  // restore the active document that existed when its close action began.
  try {
    ps.app.activeDocument = originalDoc;
    if (!ps.app.activeDocument || ps.app.activeDocument.id !== originalDoc.id) {
      throw new Error("无法在关闭临时副本前激活原文档。");
    }
  } catch (error) {
    errors.push(error);
  }

  for (let i = temporaryDocs.length - 1; i >= 0; i--) {
    const temporary = temporaryDocs[i];
    try {
      if (!autoCloseIds.has(temporary.id)) {
        await executionContext.hostControl.registerAutoCloseDocument(temporary.id);
        autoCloseIds.add(temporary.id);
      }
      if (typeof temporary.closeWithoutSaving === "function") {
        await temporary.closeWithoutSaving();
      } else {
        throw new Error("临时副本缺少无提示关闭接口。");
      }
      if (listDocuments(ps).some(item => item.id === temporary.id)) {
        throw new Error("Photoshop 返回后临时副本仍处于打开状态。");
      }
      if (autoCloseIds.has(temporary.id)) {
        await executionContext.hostControl.unregisterAutoCloseDocument(temporary.id);
        autoCloseIds.delete(temporary.id);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    ps.app.activeDocument = originalDoc;
    if (!ps.app.activeDocument || ps.app.activeDocument.id !== originalDoc.id) {
      throw new Error("无法恢复原活动文档。");
    }
  } catch (error) {
    errors.push(error);
  }

  return errors.length ? errors : null;
}

async function exportDocument(ps, doc, format, file, executionContext) {
  const requestedFormat = String(format || "").toLowerCase();
  const normalizedFormat = requestedFormat === "jpeg" ? "jpg" : requestedFormat === "tif" ? "tiff" : requestedFormat;
  // Keep legacy callers on the native Quick Export menu path for PNG. The
  // file argument is intentionally ignored because Photoshop owns its dialog.
  if (normalizedFormat === "png") return exportQuickPNG(ps, doc, executionContext);
  validateInput(ps, doc, normalizedFormat, file, executionContext);
  checkCancelled(executionContext);

  const isNativeSave = normalizedFormat === "psd" || normalizedFormat === "tiff";
  const originalState = isNativeSave
    ? readNativeSaveState(doc, ps.constants)
    : readDocumentState(doc, ps.constants);
  if (normalizedFormat === "jpg" && originalState.bitsPerChannel === 32) {
    throw makeError("不支持导出 32 位/通道文档，请先在 Photoshop 中手动转换位深。", "EXPORT_32_BIT_UNSUPPORTED");
  }
  if (normalizedFormat === "jpg") validateMode(normalizedFormat, originalState.mode);

  const existingDocs = listDocuments(ps);
  if (!existingDocs.some(item => item.id === doc.id)) {
    throw makeError("要导出的文档已关闭或无法访问。", "EXPORT_DOCUMENT_CLOSED");
  }
  const existingIds = new Set(existingDocs.map(item => item.id));
  let failure = null;
  let result = null;
  let temporaryName = null;
  let temporaryDoc = null;
  const autoCloseIds = new Set();

  try {
    checkCancelled(executionContext);
    temporaryName = "__QUICK_EXPORT_TEMP_" + doc.id + "_" + Date.now() + "__";
    const copy = await doc.duplicate(temporaryName, normalizedFormat === "png");
    temporaryDoc = copy;
    if (!copy || !Number.isInteger(copy.id) || copy.id === doc.id) {
      throw makeError("Photoshop 未创建有效的临时导出副本。", "EXPORT_DUPLICATE_FAILED");
    }
    await executionContext.hostControl.registerAutoCloseDocument(copy.id);
    autoCloseIds.add(copy.id);
    if (!ps.app.activeDocument || ps.app.activeDocument.id !== copy.id) {
      throw makeError("创建临时副本后活动文档状态异常，已停止导出。", "EXPORT_DUPLICATE_ACTIVATION_FAILED");
    }

    checkCancelled(executionContext);
    const preparedState = isNativeSave
      ? originalState
      : await prepareCopy(copy, ps, normalizedFormat, originalState);
    checkCancelled(executionContext);

    const saveAs = copy.saveAs;
    if (normalizedFormat === "psd") {
      if (!saveAs || typeof saveAs.psd !== "function") {
        throw makeError("当前 Photoshop 环境不支持 PSD 保存接口。", "EXPORT_SAVE_UNAVAILABLE");
      }
      await saveAs.psd(file, { layers: true }, true);
    } else if (normalizedFormat === "tiff") {
      await saveTiffDocument(ps, copy, file, executionContext);
    } else if (!saveAs || typeof saveAs[normalizedFormat] !== "function") {
      throw makeError("当前 Photoshop 环境不支持 " + normalizedFormat.toUpperCase() + " 保存接口。", "EXPORT_SAVE_UNAVAILABLE");
    } else if (normalizedFormat === "jpg") {
      await saveAs.jpg(file, { quality: 12, embedColorProfile: true }, true);
    } else {
      const pngMethod = ps.constants && ps.constants.PNGMethod;
      const pngOptions = { interlaced: false };
      if (pngMethod && pngMethod.THOROUGH !== undefined) pngOptions.method = pngMethod.THOROUGH;
      await saveAs.png(file, pngOptions, true);
    }

    result = {
      file,
      format: normalizedFormat,
      extension: FORMATS[normalizedFormat].extension,
      width: originalState.width,
      height: originalState.height,
      mode: preparedState.mode,
      bitsPerChannel: preparedState.bitsPerChannel
    };
  } catch (error) {
    failure = isCancellationError(error, executionContext)
      ? exportCancellationError(error)
      : error;
  }

  const cleanupErrors = await cleanupTemporaryDocument(
    ps, doc, existingIds, temporaryDoc && temporaryDoc.id, temporaryName, temporaryDoc, executionContext, autoCloseIds
  );
  if (failure) {
    if (cleanupErrors) {
      failure.cleanupErrors = cleanupErrors;
      failure.message += " 临时副本清理或恢复原活动文档时也发生错误。";
    }
    throw failure;
  }
  if (cleanupErrors) {
    const error = makeError("导出文件已保存，但无法完整关闭临时副本或恢复原活动文档。", "EXPORT_CLEANUP_FAILED", cleanupErrors[0]);
    error.outputSaved = true;
    error.cleanupErrors = cleanupErrors;
    throw error;
  }
  return result;
}

module.exports = { exportDocument, exportQuickPNG, saveTiffDocument };
