"use strict";

// 在线更新：检查 GitHub Release -> 按文件下载 -> 安全写入插件目录。
// UXP 没有内置解压能力，因此继续使用 Git tree + raw 文件接口。

const uxp = require("uxp");
const fs = uxp.storage.localFileSystem;
const TOKEN_FILE = "update-target.json";
const PLUGIN_ID = "com.local.layout-guides";
const REQUEST_TIMEOUT_MS = 15000;

// 写二进制必须显式带 format，否则 UXP 会按 UTF-8 处理。
const BINARY_FORMAT = (uxp.storage.formats && uxp.storage.formats.binary) || "binary";
const BINARY_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "ttf", "otf", "woff", "woff2", "ccx", "zip"
];

function isBinary(path) {
  const name = path.split("/").pop();
  const dot = name.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTENSIONS.indexOf(name.slice(dot + 1).toLowerCase()) >= 0;
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

function networkError(error, action) {
  const detail = error && error.message ? error.message : String(error || "未知网络错误");
  return new Error(action + "失败：无法连接 GitHub（" + detail + "）。请检查网络或代理设置。");
}

function timeoutError(action) {
  const error = new Error(action + "超时（15 秒内未完成）。请检查网络或代理设置后重试。");
  error.code = "UPDATE_REQUEST_TIMEOUT";
  return error;
}

// 一个总时限同时覆盖 fetch 和响应体读取；不依赖 AbortController。
async function request(url, options, action, consume) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(action)), REQUEST_TIMEOUT_MS);
  });
  const wait = promise => Promise.race([Promise.resolve(promise), timeout]);
  let response;
  try { response = await wait(fetch(url, options)); }
  catch (error) {
    clearTimeout(timer);
    if (error && error.code === "UPDATE_REQUEST_TIMEOUT") throw error;
    throw networkError(error, action);
  }
  try { return await consume(response, wait); }
  finally { clearTimeout(timer); }
}

async function apiGet(path) {
  return request("https://api.github.com/repos/" + path, {
    headers: { "Accept": "application/vnd.github+json" }
  }, "请求 GitHub API", async (response, wait) => {
  if (!response.ok) {
    const error = new Error(response.status === 403
      ? "GitHub 拒绝了请求（403），可能是访问频率超限，稍后再试。"
      : "GitHub API 请求失败（" + response.status + " " + (response.statusText || "") + "）：" + path);
    error.status = response.status;
    throw error;
  }
  try { return await wait(response.json()); }
  catch (error) {
    if (error && error.code === "UPDATE_REQUEST_TIMEOUT") throw error;
    throw new Error("GitHub API 返回了无法解析的数据：" + path);
  }
  });
}

async function fetchLatestRelease(repo) {
  const data = await apiGet(repo + "/releases/latest");
  const ref = data.tag_name || "";
  if (!ref) throw new Error("GitHub 最新 Release 没有 tag_name，无法确定更新版本。");
  return {
    ref,
    notes: data.body || "",
    page: data.html_url || ("https://github.com/" + repo + "/releases")
  };
}

function safeRelativePath(path) {
  if (typeof path !== "string" || !path || path.charAt(0) === "/" || path.indexOf("\\") >= 0) return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === ".." || segment.indexOf(":") >= 0) return false;
  }
  return true;
}

async function listFiles(repo, ref, subdir) {
  const data = await apiGet(repo + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1");
  if (data.truncated) throw new Error("GitHub 返回的文件清单不完整，已中止更新。");
  const prefix = subdir ? subdir.replace(/\/+$/, "") + "/" : "";
  const files = (data.tree || [])
    .filter(node => node.type === "blob" && typeof node.path === "string")
    .map(node => node.path)
    .filter(path => !prefix || path.indexOf(prefix) === 0)
    .map(path => path.slice(prefix.length))
    .filter(path => path && path.indexOf(".") !== 0 && path.split("/").indexOf("node_modules") < 0);
  for (const path of files) {
    if (!safeRelativePath(path)) throw new Error("更新文件路径不安全，已中止：" + path);
  }
  return files.sort((a, b) => {
    if (a === "manifest.json") return 1;
    if (b === "manifest.json") return -1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
}

function contentsUrl(repo, ref, fullPath) {
  const encodedPath = fullPath.split("/").map(encodeURIComponent).join("/");
  return "https://api.github.com/repos/" + repo + "/contents/" + encodedPath + "?ref=" + encodeURIComponent(ref);
}

async function readResponseFile(response, wait, fullPath, source) {
  if (!response.ok) throw new Error(source + "下载 " + fullPath + " 失败（HTTP " + response.status + "）。");
  if (isBinary(fullPath)) return { binary: true, data: await wait(response.arrayBuffer()) };
  return { binary: false, data: await wait(response.text()) };
}

async function downloadRawFile(repo, ref, fullPath) {
  const url = "https://raw.githubusercontent.com/" + repo + "/" + ref + "/" + fullPath;
  return request(url, null, "下载 " + fullPath,
    (response, wait) => readResponseFile(response, wait, fullPath, "raw 域"));
}

async function downloadContentsFile(repo, ref, fullPath) {
  return request(contentsUrl(repo, ref, fullPath), {
    headers: { "Accept": "application/vnd.github.raw+json" }
  }, "通过 GitHub Contents API 下载 " + fullPath,
  (response, wait) => readResponseFile(response, wait, fullPath, "GitHub Contents API"));
}

async function downloadFile(repo, ref, fullPath, useContentsApi) {
  if (useContentsApi) return downloadContentsFile(repo, ref, fullPath);
  return downloadRawFile(repo, ref, fullPath);
}

function parseManifest(text, description) {
  let data;
  try { data = JSON.parse(text); }
  catch (_) { throw new Error(description + "不是合法 JSON。"); }
  if (!data || typeof data !== "object") throw new Error(description + "内容无效。");
  if (data.id !== PLUGIN_ID) throw new Error(description + "的插件 ID 不匹配（预期 " + PLUGIN_ID + "）。");
  if (!data.version || !/^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/.test(normalizeVersion(data.version))) {
    throw new Error(description + "缺少有效的 version 字段。");
  }
  return data;
}

// 直接读取 Release tag 对应的 manifest；Release tag 才是更新来源。
async function remoteManifest(repo, ref, subdir) {
  const path = (subdir ? subdir.replace(/\/+$/, "") + "/" : "") + "manifest.json";
  let content;
  try { content = await downloadContentsFile(repo, ref, path); }
  catch (apiError) {
    try { content = await downloadRawFile(repo, ref, path); }
    catch (rawError) {
      throw new Error("无法读取仓库里的 manifest.json。GitHub Contents API：" + apiError.message + "；raw 备用读取：" + rawError.message + "。请核对 REPO、Release tag 和 SUBDIR。");
    }
  }
  return parseManifest(content.data, "仓库里的 manifest.json");
}

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
      if (error.status === 404) {
        throw new Error("没有找到 GitHub 最新 Release（404）。请核对仓库地址，或先发布一个正式 Release。");
      }
      throw error;
    }
  }
  if (!ref) throw new Error("无法确定要拉取的版本，请检查 GitHub Release 设置。");
  const current = normalizeVersion(currentVersion);
  if (!/^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/.test(current)) {
    throw new Error("当前插件版本号无效：" + (current || "（空）") + "。");
  }
  const manifest = await remoteManifest(repo, ref, subdir);
  const latest = normalizeVersion(manifest.version);
  const comparison = compareVersions(latest, current);
  return {
    current, latest, ref, notes, page,
    hasUpdate: comparison > 0,
    isCurrent: comparison === 0,
    isAhead: comparison < 0
  };
}

async function findChild(folder, name, path) {
  if (!folder || !folder.isFolder) {
    throw new Error("目标目录中的路径结构不正确，无法检查：" + path);
  }
  let entries;
  try { entries = await folder.getEntries(); }
  catch (error) {
    const detail = error && error.message ? error.message : String(error || "未知错误");
    throw new Error("无法检查目标目录中的路径 " + path + "（" + detail + "）。为避免覆盖已有文件，已中止。");
  }
  let exact = null;
  const foldedName = String(name).toLowerCase();
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string") continue;
    if (entry.name === name) exact = entry;
    else if (entry.name.toLowerCase() === foldedName) {
      throw new Error("目标目录存在大小写冲突的路径（" + path + " 与 " + entry.name + "）。为避免覆盖错误文件，已中止。");
    }
  }
  return exact;
}

async function entryAt(root, path) {
  let entry = root;
  let lookupPath = "";
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    lookupPath = lookupPath ? lookupPath + "/" + segments[i] : segments[i];
    entry = await findChild(entry, segments[i], lookupPath);
    if (!entry) return null;
    if (i < segments.length - 1 && !entry.isFolder) {
      throw new Error("目标目录中的路径结构不正确：" + path);
    }
  }
  return entry;
}

async function readTargetManifest(folder) {
  if (!folder || !folder.isFolder) throw new Error("所选项目录无效，请选择插件根目录。");
  let entry;
  try { entry = await folder.getEntry("manifest.json"); }
  catch (_) { throw new Error("所选目录不是插件根目录（缺少 manifest.json）。请选中品牌版式标准规范 PS 插件本身。"); }
  if (!entry || entry.isFolder) throw new Error("所选目录的 manifest.json 无效，请选中插件根目录。");
  return parseManifest(await entry.read(), "所选目录的 manifest.json");
}

async function getFolder(root, segments, create, createdFolders) {
  let folder = root;
  let path = "";
  for (const segment of segments) {
    path = path ? path + "/" + segment : segment;
    const next = await findChild(folder, segment, path);
    if (next) {
      if (!next.isFolder) throw new Error("目标目录中的路径结构不正确：" + path);
      folder = next;
    } else {
      if (!create) return null;
      folder = await folder.createFolder(segment);
      createdFolders.push(path);
    }
  }
  return folder;
}

async function writeFile(root, path, content, createdFolders) {
  const segments = path.split("/");
  const name = segments.pop();
  const folder = await getFolder(root, segments, true, createdFolders);
  const file = await folder.createFile(name, { overwrite: true });
  if (content.binary) await file.write(content.data, { format: BINARY_FORMAT });
  else await file.write(content.data);
}

async function writeEntry(entry, content) {
  if (content.binary) await entry.write(content.data, { format: BINARY_FORMAT });
  else await entry.write(content.data);
}

async function cleanupCreatedFolders(root, paths) {
  for (let i = paths.length - 1; i >= 0; i--) {
    try {
      const entry = await entryAt(root, paths[i]);
      if (entry && entry.isFolder && (await entry.getEntries()).length === 0) await entry.delete();
    } catch (_) { /* Best effort; the install error remains the primary error. */ }
  }
}

async function rollback(root, attempted, backups, createdFolders, onProgress) {
  const errors = [];
  const report = (completed, total) => {
    if (!onProgress) return;
    try { onProgress({ phase: "rollback", completed, total, percent: null }); }
    catch (_) { /* Progress observers must not interrupt recovery. */ }
  };
  report(0, attempted.length);
  for (let i = attempted.length - 1; i >= 0; i--) {
    const path = attempted[i];
    try {
      const backup = backups[path];
      if (backup.exists) {
        await writeFile(root, path, backup.content, []);
      } else {
        const entry = await entryAt(root, path);
        if (entry) await entry.delete();
      }
    } catch (error) { errors.push(path + "：" + (error && error.message ? error.message : String(error))); }
    report(attempted.length - i, attempted.length);
  }
  await cleanupCreatedFolders(root, createdFolders);
  return errors;
}

// 下载和校验全部完成后才开始写目标目录。若写入失败，会按快照回滚已触及文件。
async function install(repo, ref, subdir, targetFolder, onProgress) {
  const report = (phase, completed, total, percent) => {
    if (!onProgress) return;
    try { onProgress({ phase, completed, total, percent }); }
    catch (_) { /* Progress observers must not interrupt the update. */ }
  };
  const percent = (completed, total) => total ? Math.floor(completed * 100 / total) : 0;
  if (!targetFolder) throw new Error("尚未选择插件目录。");
  report("prepare", 0, 0, null);
  const localManifest = await readTargetManifest(targetFolder);
  const files = await listFiles(repo, ref, subdir);
  if (!files.length) throw new Error("仓库里没有找到可更新的文件，请检查 SUBDIR 配置。");
  if (files.indexOf("manifest.json") < 0) {
    throw new Error("仓库里没有找到 manifest.json，SUBDIR 可能填错了。为避免覆盖错误目录，已中止。");
  }

  report("prepare", 0, files.length, null);
  const staged = [];
  let useContentsApi = false;
  report("download", 0, files.length, 0);
  for (const path of files) {
    const fullPath = (subdir ? subdir.replace(/\/+$/, "") + "/" : "") + path;
    let content;
    if (useContentsApi) {
      content = await downloadFile(repo, ref, fullPath, true);
    } else {
      try { content = await downloadFile(repo, ref, fullPath, false); }
      catch (rawError) {
        useContentsApi = true;
        try { content = await downloadFile(repo, ref, fullPath, true); }
        catch (apiError) {
          throw new Error("下载 " + fullPath + " 失败。raw 域：" + rawError.message + "；GitHub Contents API：" + apiError.message);
        }
      }
    }
    staged.push({ path, content });
    report("download", staged.length, files.length, percent(staged.length, files.length));
  }

  const remoteItem = staged.find(item => item.path === "manifest.json");
  const remote = parseManifest(remoteItem.content.data, "下载的 manifest.json");
  if (compareVersions(remote.version, localManifest.version) <= 0) {
    throw new Error("下载版本 v" + normalizeVersion(remote.version) + " 不高于已安装版本 v" + normalizeVersion(localManifest.version) + "，已中止以避免降级。");
  }

  // 在插件数据目录保留可恢复的原件；即使回滚遇到磁盘/权限错误，也不会丢掉恢复材料。
  report("backup", 0, staged.length, 0);
  const dataFolder = await fs.getDataFolder();
  const recoveryName = "layout-guides-update-recovery-" + Date.now() + "-" + Math.floor(Math.random() * 1000000);
  let recoveryFolder;
  try { recoveryFolder = await dataFolder.createFolder(recoveryName); }
  catch (error) {
    throw new Error("无法在插件数据目录建立临时恢复备份（" + (error && error.message ? error.message : String(error)) + "），插件文件尚未修改。");
  }

  // 先为所有受影响文件制作内存快照和磁盘备份。失败时尚未改写插件。
  const backups = Object.create(null);
  let backupCompleted = 0;
  try {
    for (const item of staged) {
      const entry = await entryAt(targetFolder, item.path);
      if (entry && entry.isFolder) throw new Error("目标目录中文件位置被同名文件夹占用：" + item.path);
      if (entry) {
        const binary = isBinary(item.path);
        const content = { binary, data: await entry.read(binary ? { format: BINARY_FORMAT } : undefined) };
        backups[item.path] = { exists: true, content };
        await writeFile(recoveryFolder, item.path, content, []);
      } else {
        backups[item.path] = { exists: false, content: null };
      }
      backupCompleted++;
      // 延后报告最后一项，直到恢复信息也已写入，避免准备阶段显示 100%。
      if (backupCompleted < staged.length) {
        report("backup", backupCompleted, staged.length, percent(backupCompleted, staged.length));
      }
    }
    const info = await recoveryFolder.createFile("recovery-info.json", { overwrite: true });
    await info.write(JSON.stringify({ pluginId: PLUGIN_ID, oldVersion: localManifest.version, newVersion: remote.version,
      files: staged.map(item => ({ path: item.path, existed: backups[item.path].exists, binary: isBinary(item.path) })) }, null, 2));
    report("backup", staged.length, staged.length, 100);
  } catch (error) {
    try { await recoveryFolder.delete(); } catch (_) { /* No target file has changed. */ }
    throw new Error("无法为更新制作完整恢复备份（" + (error && error.message ? error.message : String(error)) + "），插件文件尚未修改。");
  }

  const attempted = [];
  const createdFolders = [];
  let installCompleted = 0;
  report("install", 0, staged.length, 0);
  try {
    for (const item of staged) {
      attempted.push(item.path);
      await writeFile(targetFolder, item.path, item.content, createdFolders);
      installCompleted++;
      report("install", installCompleted, staged.length, percent(installCompleted, staged.length));
    }
  } catch (error) {
    const rollbackErrors = await rollback(targetFolder, attempted, backups, createdFolders,
      event => report(event.phase, event.completed, event.total, event.percent));
    const detail = error && error.message ? error.message : String(error);
    if (rollbackErrors.length) {
      const recoveryPath = recoveryFolder.nativePath || recoveryFolder.name || recoveryName;
      throw new Error("更新写入失败（" + detail + "）；自动恢复也有失败项：" + rollbackErrors.join("；") + "。原文件备份保存在插件数据目录：" + recoveryPath + "。请从该目录恢复文件或手动重新安装完整版本。");
    }
    try { await recoveryFolder.delete(); }
    catch (_) {
      const recoveryPath = recoveryFolder.nativePath || recoveryFolder.name || recoveryName;
      throw new Error("更新写入失败（" + detail + "）；已恢复本次改动，插件文件保持原版本。临时恢复备份清理失败，位置：" + recoveryPath);
    }
    throw new Error("更新写入失败（" + detail + "）；已恢复本次改动，插件文件保持原版本。");
  }
  report("complete", staged.length, staged.length, 100);
  try { await recoveryFolder.delete(); } catch (_) { /* A leftover recovery copy does not affect the installed version. */ }
  return staged.length;
}

/* ---------- 目标目录（记住用户选过一次的位置） ---------- */

async function writeDataFile(name, text) {
  const folder = await fs.getDataFolder();
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(text);
  return file;
}

async function readToken() {
  try {
    const folder = await fs.getDataFolder();
    const entry = await folder.getEntry(TOKEN_FILE);
    const data = JSON.parse(await entry.read());
    return data && data.token ? data.token : "";
  } catch (_) { return ""; }
}

function normalizedNativePath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let path = value.trim();
  const drivePath = /^\/?[A-Za-z]:[\\/]/.test(path);
  const uncPath = /^\\\\/.test(path) || /^\/\/[^/]/.test(path);
  if (drivePath || uncPath) {
    path = path.replace(/\\/g, "/");
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (/^[A-Za-z]:\//.test(path)) {
      const drive = path.slice(0, 2).toLowerCase();
      let tail = "/" + path.slice(3).replace(/\/{2,}/g, "/");
      while (tail.length > 1 && tail.charAt(tail.length - 1) === "/") tail = tail.slice(0, -1);
      return { kind: "windows", value: drive + tail.toLowerCase() };
    }
    let unc = "//" + path.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
    while (unc.length > 2 && unc.charAt(unc.length - 1) === "/") unc = unc.slice(0, -1);
    return { kind: "windows", value: unc.toLowerCase() };
  }
  if (path.charAt(0) !== "/") return null;
  while (path.length > 1 && path.charAt(path.length - 1) === "/") path = path.slice(0, -1);
  return { kind: "posix", value: path };
}

function sameNativePath(left, right) {
  const a = normalizedNativePath(left);
  const b = normalizedNativePath(right);
  return !!a && !!b && a.kind === b.kind && a.value === b.value;
}

async function getCurrentPluginFolder() {
  let folder;
  try { folder = await fs.getPluginFolder(); }
  catch (error) {
    const detail = error && error.message ? error.message : String(error || "未知错误");
    throw new Error("无法确认当前运行插件目录（" + detail + "）。请重新打开更新面板后重试。");
  }
  if (!folder || !folder.isFolder || !normalizedNativePath(folder.nativePath)) {
    throw new Error("无法读取当前插件的完整安装位置，请重新打开插件面板后重试。");
  }
  return folder;
}

function assertCurrentPluginFolder(folder, currentFolder) {
  if (!folder || !normalizedNativePath(folder.nativePath)) {
    throw new Error("无法确认所选文件夹的完整位置，请重新选择当前插件的安装文件夹。");
  }
  if (!sameNativePath(folder.nativePath, currentFolder.nativePath)) {
    throw new Error("所选目录与当前运行插件的安装目录不一致。请确认并选择当前安装的插件文件夹。");
  }
}

async function getTargetLocation() {
  const folder = await getCurrentPluginFolder();
  return folder.nativePath;
}

async function resolveTarget() {
  const token = await readToken();
  if (!token) return null;
  try {
    const folder = await fs.getEntryForPersistentToken(token);
    await readTargetManifest(folder);
    const currentFolder = await getCurrentPluginFolder();
    assertCurrentPluginFolder(folder, currentFolder);
    return folder;
  } catch (_) { return null; }
}

async function chooseTarget() {
  const currentFolder = await getCurrentPluginFolder();
  let folder;
  try { folder = await fs.getFolder({ initialLocation: currentFolder }); }
  catch (_) {
    // 2022 FileSystemProvider 文档没有说明 getFolder 支持 initialLocation。
    // 若宿主拒绝此提示参数，退回官方支持的普通目录选择器；不自动重试取消操作。
    folder = await fs.getFolder();
  }
  if (!folder) return null;
  await readTargetManifest(folder);
  assertCurrentPluginFolder(folder, currentFolder);
  try {
    const token = await fs.createPersistentToken(folder);
    await writeDataFile(TOKEN_FILE, JSON.stringify({ token }));
  } catch (error) {
    const detail = error && error.message ? error.message : String(error || "未知错误");
    throw new Error("已选择当前插件目录，但无法保存授权信息（" + detail + "）。请重试授权，成功后下次可直接更新。");
  }
  return folder;
}

module.exports = {
  compareVersions, normalizeVersion,
  check, install, resolveTarget, chooseTarget, getTargetLocation, writeDataFile
};
