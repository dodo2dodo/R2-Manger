import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { DialogProvider, ToastProvider } from "./ui";
import "./index.css";

// 屏蔽 WebView 原生浏览器右键菜单，开发模式按住 Alt/Option 右键可放行 Inspect
window.addEventListener("contextmenu", (e) => {
  // 开发模式下：按住 Alt/Option 键右键，放行系统原生“检查元素”调试菜单
  if (import.meta.env.DEV && (e.altKey || e.metaKey)) {
    return;
  }

  const target = e.target as HTMLElement | null;
  // 允许输入框或文本域的原生复制/粘贴右键菜单
  const isInput =
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable);
  if (!isInput) {
    e.preventDefault();
  }
});

// 开发模式支持 F12 或 Cmd+Option+I / Ctrl+Shift+I 快捷键呼出 DevTools
if (import.meta.env.DEV) {
  window.addEventListener("keydown", async (e) => {
    const isDevToolsKey =
      e.key === "F12" ||
      ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === "i" || e.key === "I")) ||
      ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "i" || e.key === "I"));

    if (isDevToolsKey) {
      try {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const win = getCurrentWebviewWindow();
        // @ts-ignore
        if (typeof win.openDevTools === "function") {
          // @ts-ignore
          win.openDevTools();
        }
      } catch (err) {
        console.warn("无法打开 DevTools 窗口:", err);
      }
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ToastProvider>
      <DialogProvider>
        <App />
      </DialogProvider>
    </ToastProvider>
  </React.StrictMode>
);
