"use strict";

const { saveTiffDocument } = require("./export-service.js");

function isSaveCancelled(error) {
  return !!error && (error.number === -128 || error.code === -128 ||
    error.code === "EXPORT_CANCELLED" || error.cancelled === true);
}

// 先让用户确认，再进入 Photoshop 原生保存流程；插件不指定文件名或格式。
async function confirmDocumentSave(document, message) {
  const dialog = document.createElement("dialog");
  dialog.className = "save-dialog";
  dialog.setAttribute("aria-label", "当前文件未保存");
  const title = document.createElement("div");
  title.className = "save-dialog-title";
  title.textContent = "当前文件未保存";
  const text = document.createElement("div");
  text.className = "save-dialog-message";
  text.textContent = message;
  const buttons = document.createElement("div");
  buttons.className = "save-dialog-buttons";
  for (const [label, value, variant] of [["取消", "cancel", "secondary"], ["现在保存", "save", "cta"]]) {
    const button = document.createElement("sp-button");
    button.setAttribute("variant", variant);
    button.textContent = label;
    button.addEventListener("click", () => dialog.close(value));
    buttons.appendChild(button);
  }
  dialog.appendChild(title);
  dialog.appendChild(text);
  dialog.appendChild(buttons);
  document.body.appendChild(dialog);
  try {
    // Esc / 标题栏关闭由 UXP 返回 reasonCanceled，与“取消”一样不保存。
    return await dialog.uxpShowModal({ title: "保存当前文件", resize: "none", size: { width: 360, height: 190 } }) === "save";
  } finally {
    dialog.parentNode.removeChild(dialog);
  }
}

async function saveWithModal(ps, doc, isCurrent, operation, commandName, options = {}) {
  let cancelled = false;
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error("当前文档已切换或关闭，请在目标文档重新操作。");
  };
  checkCurrent();
  try {
    await ps.core.executeAsModal(async context => {
      checkCurrent();
      if (context.isCancelled) { cancelled = true; return; }
      try {
        const current = ps.app ? ps.app.activeDocument : doc;
        if (!current || (doc.id != null && current.id !== doc.id)) {
          throw new Error("当前文档已切换或关闭，请在目标文档重新操作。");
        }
        await operation(current, context);
      } catch (error) {
        if (context.isCancelled || isSaveCancelled(error)) {
          cancelled = true;
          return;
        }
        throw error;
      }
      cancelled = context.isCancelled;
      checkCurrent();
    }, { commandName, interactive: true });
  } catch (error) {
    if (isSaveCancelled(error)) return false;
    throw error;
  }
  checkCurrent();
  if (cancelled) return false;
  // Save may replace the DOM wrapper or finish updating its saved flag later.
  // Never hide the badge based only on the command returning successfully.
  const attempts = options.attempts || 26;
  const pause = options.pause || (() => new Promise(resolve => setTimeout(resolve, 200)));
  for (let i = 0; i < attempts; i++) {
    checkCurrent();
    const current = ps.app ? ps.app.activeDocument : doc;
    if (!current || (doc.id != null && current.id !== doc.id)) {
      throw new Error("当前文档已切换或关闭，请在目标文档重新操作。");
    }
    if (current.saved === true) return true;
    if (i + 1 < attempts) await pause();
  }
  return false;
}

async function saveDocument(ps, doc, isCurrent, options) {
  return saveWithModal(ps, doc, isCurrent, current => current.save(), "保存当前文件", options);
}

async function saveDocumentAs(ps, doc, format, file, isCurrent, options) {
  if (format !== "psd" && format !== "tiff") throw new Error("请选择PSD或TIFF保存格式。");
  if (!file || typeof file !== "object") throw new Error("没有选择有效的保存位置。");
  return saveWithModal(ps, doc, isCurrent, async (current, context) => {
    if (format === "psd") {
      if (!current.saveAs || typeof current.saveAs.psd !== "function") {
        throw new Error("当前Photoshop环境不支持PSD储存为接口。");
      }
      await current.saveAs.psd(file, { layers: true }, false);
    } else {
      await saveTiffDocument(ps, current, file, context, false);
    }
  }, "将当前文件储存为 " + format.toUpperCase(), options);
}

module.exports = { confirmDocumentSave, saveDocument, saveDocumentAs };
