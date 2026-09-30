"use strict";

// Document.path 是完整文件路径；云文档标识和相对路径不能交给系统打开。
function documentFolder(doc) {
  if (!doc || doc.cloudDocument) return "";
  let path;
  // 从未保存的文档在部分宿主版本中读取 path 会抛错。
  try { path = doc.path; } catch (_) { return ""; }
  if (typeof path !== "string" || !path || /[\0\r\n]/.test(path)) return "";
  const windows = /^[a-z]:[\\/]/i.test(path) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]/.test(path);
  if (windows) path = path.replace(/\//g, "\\");
  else if (path[0] !== "/" || path[1] === "/") return "";
  const separator = windows ? "\\" : "/";
  const last = path.lastIndexOf(separator);
  if (last < 0 || last === path.length - 1) return "";
  // 保留末尾分隔符，也适用于磁盘根目录、网络共享、带点的文件夹名称。
  return path.slice(0, last + 1);
}

function documentIsUnsaved(doc) {
  return !!doc && (doc.saved === false || (!doc.cloudDocument && !documentFolder(doc)));
}

module.exports = { documentFolder, documentIsUnsaved };
