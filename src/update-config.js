"use strict";

// 在线更新配置。
//
// REPO：GitHub 仓库的 owner/repo，例如 "owner/repo"。
//       不要带 https://github.com/ 前缀，也不要带 .git 后缀。
//       留空时「检查更新」会提示尚未配置，插件的其它功能完全不受影响。
// SUBDIR：插件在仓库里的子目录。仓库根目录就是插件时留空。
//        例如插件放在仓库的 "plugin" 目录下，就填 "plugin"。
// REF_OVERRIDE：留空表示跟随 GitHub 最新 Release 的 tag。
//        也可以填分支名（如 "main"），此时按分支最新提交更新，不依赖 Release。
// VERSION：面板显示的版本号，必须与 manifest.json 的 version 保持一致。
const REPO = "BUYAOJIAOWOSHUNSHUN/PS-LayoutGuides-Releases";
const SUBDIR = "";
const REF_OVERRIDE = "";
const VERSION = "1.9.17";

module.exports = { REPO, SUBDIR, REF_OVERRIDE, VERSION };
