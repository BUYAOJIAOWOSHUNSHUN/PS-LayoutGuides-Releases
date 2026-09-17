"use strict";

// 在线更新：检查 GitHub 版本 → 按文件拉取 → 覆盖到插件目录。
// 不走 zip，因为 UXP 没有内置解压能力；改为用 GitHub 的 tree 接口列出文件，
// 再逐个从 raw 地址下载覆盖，逻辑更简单，失败也能定位到具体文件。

const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;
const TOKEN_FILE = "update-target.json";

// 写二进制必须显式带 format，否则 UXP 按 UTF-8 处理，PNG 会被写坏。
const BINARY_FORMAT = (uxp.storage.formats && uxp.storage.formats.binary) || "binary";

// 这些后缀必须按二进制下载与写入。assets 里的图标和品牌图形都是 PNG，
// 漏掉它们的话更新一次图片就全毁了（文件在、但打不开）。
const BINARY_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "ttf", "otf", "woff", "woff2", "ccx", "zip"
];

function isBinary(path) {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) >= 0;
}

function normalizeVersion(text) {
  return String(text == null ? "" : text).trim().replace(/^v/i, "");
}

// 逐段比较 x.y.z。返回 1 表示 a 更新，-1 表示 b 更新，0 表示相同。
function compareVersions(a, b) {
  const pa = normalizeVersion(a).split(".").map(n => parseInt(n, 10) || 0);
  const pb = normalizeVersion(b).split(".").map(n => parseInt(n, 10) || 0);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function apiGet(path) {
  const response = await fetch("https://api.github.com/repos/" + path, {
    headers: { "Accept": "application/vnd.github+json" }
  });
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("仓库或发布不存在（404）。请核对仓库地址；私有仓库需要先设为公开，或改用其它分发方式。");
    }
    if (response.status === 403) {
      throw new Error("GitHub 拒绝了请求（403），可能是访问频率超限，稍后再试。");
    }
    throw new Error("GitHub 返回 " + response.status + " " + (response.statusText || "") + "。");
  }
  return await response.json();
}

async function fetchLatestRelease(repo) {
  const data = await apiGet(repo + "/releases/latest");
  const tag = data.tag_name || data.name || "";
  return {
    version: normalizeVersion(tag),
    ref: tag,
    notes: data.body || "",
    page: data.html_url || ("https://github.com/" + repo + "/releases")
  };
}

async function listFiles(repo, ref, subdir) {
  const data = await apiGet(repo + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1");
  const prefix = subdir ? subdir.replace(/\/+$/, "") + "/" : "";
  return (data.tree || [])
    .filter(node => node.type === "blob")
    .map(node => node.path)
    .filter(path => !prefix || path.indexOf(prefix) === 0)
    .map(path => path.slice(prefix.length))
    .filter(path => path && path.indexOf(".") !== 0)
    .filter(path => path.indexOf("node_modules/") !== 0);
}

// 按文件类型选读法：文本走 text()，图片等走 arrayBuffer()。
async function downloadFile(repo, ref, fullPath) {
  const response = await fetch("https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + fullPath);
  if (!response.ok) throw new Error("下载 " + fullPath + " 失败（" + response.status + "）。");
  if (isBinary(fullPath)) return { binary: true, data: await response.arrayBuffer() };
  return { binary: false, data: await response.text() };
}

// 直接读仓库里的 manifest.json 取版本号，比依赖 Release 的 tag 更可靠。
async function remoteVersion(repo, ref, subdir) {
  const path = (subdir ? subdir.replace(/\/+$/, "") + "/" : "") + "manifest.json";
  const response = await fetch("https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + path);
  if (!response.ok) throw new Error("无法读取仓库里的 manifest.json（" + response.status + "）。请核对 REPO 和 SUBDIR。");
  let data;
  try { data = JSON.parse(await response.text()); }
  catch (_) { throw new Error("仓库里的 manifest.json 不是合法 JSON。"); }
  if (!data.version) throw new Error("仓库里的 manifest.json 缺少 version 字段。");
  return String(data.version);
}

async function ensureFolder(root, segments) {
  let folder = root;
  for (const segment of segments) {
    let next = null;
    try { next = await folder.getEntry(segment); } catch (_) { next = null; }
    folder = next && next.isFolder ? next : await folder.createFolder(segment);
  }
  return folder;
}

async function writeInto(root, path, content) {
  const segments = path.split("/");
  const name = segments.pop();
  const folder = segments.length ? await ensureFolder(root, segments) : root;
  const file = await folder.createFile(name, { overwrite: true });
  if (content && content.binary) await file.write(content.data, { format: BINARY_FORMAT });
  else await file.write(content ? content.data : content);
}

/* ---------- 目标目录（记住用户选过一次的位置） ---------- */

async function readToken() {
  try {
    const folder = await fs.getDataFolder();
    const entry = await folder.getEntry(TOKEN_FILE);
    const data = JSON.parse(await entry.read());
    return data && data.token ? data.token : "";
  } catch (_) { return ""; }
}

async function resolveTarget() {
  const token = await readToken();
  if (!token) return null;
  try { return await fs.getEntryForPersistentToken(token); } catch (_) { return null; }
}

async function chooseTarget() {
  const folder = await fs.getFolder();
  if (!folder) return null;
  const folder2 = await fs.getDataFolder();
  const entry = await folder2.createFile(TOKEN_FILE, { overwrite: true });
  await entry.write(JSON.stringify({ token: await fs.createPersistentToken(folder) }));
  return folder;
}

/* ---------- 对外接口 ---------- */

// 检查是否有新版本。repo 为空时抛出可读的提示。
// refOverride 为空时跟随 GitHub 最新 Release；仓库没有 Release 时自动退回默认分支（HEAD）。
async function check(repo, currentVersion, refOverride, subdir) {
  if (!repo) throw new Error("尚未配置更新仓库：请在本插件的 src/update-config.js 里填写 REPO。");
  let ref = refOverride || "";
  let page = "https://github.com/" + repo + "/releases";
  let notes = "";
  if (!ref) {
    try {
      const release = await fetchLatestRelease(repo);
      ref = release.ref;
      page = release.page;
      notes = release.notes;
    } catch (error) {
      if (error.message.indexOf("404") < 0) throw error;
      // 没有发布 Release 的仓库，直接按默认分支最新提交更新。
      ref = "HEAD";
      page = "https://github.com/" + repo;
    }
  }
  if (!ref) throw new Error("无法确定要拉取的版本，请检查 GitHub 仓库的 Release 设置。");
  const latest = await remoteVersion(repo, ref, subdir);
  return {
    current: normalizeVersion(currentVersion),
    latest: normalizeVersion(latest),
    ref,
    notes,
    page,
    hasUpdate: compareVersions(latest, currentVersion) > 0
  };
}

// 下载并覆盖到目标目录。返回写入的文件数。
async function install(repo, ref, subdir, targetFolder, onProgress) {
  if (!targetFolder) throw new Error("尚未选择插件目录。");
  const files = await listFiles(repo, ref, subdir);
  if (!files.length) throw new Error("仓库里没有找到可更新的文件，请检查 SUBDIR 配置。");
  if (files.indexOf("manifest.json") < 0) {
    throw new Error("仓库里没有找到 manifest.json，SUBDIR 可能填错了。为避免覆盖错误目录，已中止。");
  }
  let index = 0;
  for (const path of files) {
    index++;
    if (onProgress) onProgress(index, files.length, path);
    const content = await downloadFile(repo, ref, subdir ? subdir.replace(/\/+$/, "") + "/" + path : path);
    await writeInto(targetFolder, path, content);
  }
  return files.length;
}

module.exports = {
  compareVersions, normalizeVersion,
  check, install, resolveTarget, chooseTarget
};
