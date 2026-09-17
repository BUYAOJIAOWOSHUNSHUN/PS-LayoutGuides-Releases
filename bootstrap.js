"use strict";

// Load the HTML entry's dependencies as real CommonJS modules, with explicit
// root-relative entry and module-relative imports inside src/.
(function bootstrap() {
  function showFailure(error) {
    console.error("Layout panel startup failed:", error);
    const target = document.getElementById("status");
    if (target) {
      target.textContent = "插件启动失败：" + (error && error.message ? error.message : String(error));
      target.className = "error";
    }
  }
  function load() {
    try { require("./src/main.js").initialize(); }
    catch (error) { showFailure(error); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
  else load();
})();
