"use strict";

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

async function saveDocument(ps, doc, isCurrent) {
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
        await doc.save();
      } catch (error) {
        if (context.isCancelled || error.number === -128 || error.code === -128) {
          cancelled = true;
          return;
        }
        throw error;
      }
      cancelled = context.isCancelled;
      checkCurrent();
    }, { commandName: "保存当前文件", interactive: true });
  } catch (error) {
    if (error.number === -128 || error.code === -128) return false;
    throw error;
  }
  checkCurrent();
  return !cancelled && doc.saved === true;
}

module.exports = { confirmDocumentSave, saveDocument };
