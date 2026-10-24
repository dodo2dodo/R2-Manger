import { useState } from "react";
import { api, type Conflict } from "../api";
import { Icon } from "../icons";
import { Modal, useToast } from "../ui";

export type ThemeMode = "system" | "dark" | "light";

export interface Settings {
  theme: ThemeMode;
  concurrency: number;
  conflict: Conflict;
}

export function SettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: Settings;
  onSave: (s: Settings) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Settings>({ ...settings });
  const toast = useToast();

  const handleSave = () => {
    onSave(f);
    toast("设置已更新", "success");
    onClose();
  };

  return (
    <Modal
      title="首选项与设置"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave}>
            <Icon name="check" size={14} /> 保存设置
          </button>
        </>
      }
    >
      <div className="settings-panel">
        {/* 外观模式设置 */}
        <div className="settings-group">
          <div className="settings-group-title">
            <Icon name="sun" size={15} />
            <span>界面外观</span>
          </div>
          <div className="theme-selector">
            <button
              type="button"
              className={`theme-card ${f.theme === "dark" ? "active" : ""}`}
              onClick={() => setF({ ...f, theme: "dark" })}
            >
              <div className="theme-preview preview-dark">
                <div className="preview-top" />
                <div className="preview-body">
                  <div className="preview-side" />
                  <div className="preview-content" />
                </div>
              </div>
              <div className="theme-info">
                <div className="theme-name">
                  <Icon name="moon" size={14} /> 深色模式
                </div>
                <div className="theme-desc">深色背景护眼低噪</div>
              </div>
            </button>

            <button
              type="button"
              className={`theme-card ${f.theme === "light" ? "active" : ""}`}
              onClick={() => setF({ ...f, theme: "light" })}
            >
              <div className="theme-preview preview-light">
                <div className="preview-top" />
                <div className="preview-body">
                  <div className="preview-side" />
                  <div className="preview-content" />
                </div>
              </div>
              <div className="theme-info">
                <div className="theme-name">
                  <Icon name="sun" size={14} /> 浅色模式
                </div>
                <div className="theme-desc">清爽明亮纯净通透</div>
              </div>
            </button>

            <button
              type="button"
              className={`theme-card ${f.theme === "system" ? "active" : ""}`}
              onClick={() => setF({ ...f, theme: "system" })}
            >
              <div className="theme-preview preview-system">
                <div className="preview-top" />
                <div className="preview-body">
                  <div className="preview-side" />
                  <div className="preview-content" />
                </div>
              </div>
              <div className="theme-info">
                <div className="theme-name">
                  <Icon name="monitor" size={14} /> 跟随系统
                </div>
                <div className="theme-desc">自适应 macOS/Windows</div>
              </div>
            </button>
          </div>
        </div>

        {/* 传输设置 */}
        <div className="settings-group">
          <div className="settings-group-title">
            <Icon name="upload" size={15} />
            <span>传输与并发</span>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <div className="label-title">同时上传文件并发数</div>
              <div className="label-desc">控制最大并行处理文件个数，避免占满网络连接</div>
            </div>
            <select
              className="select compact"
              value={f.concurrency}
              onChange={(e) => setF({ ...f, concurrency: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <option key={n} value={n}>
                  {n} 个任务
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-row-label">
              <div className="label-title">同名文件处理策略</div>
              <div className="label-desc">当存储桶中已存在完全同名的文件时的默认行为</div>
            </div>
            <select
              className="select compact"
              value={f.conflict}
              onChange={(e) => setF({ ...f, conflict: e.target.value as Conflict })}
            >
              <option value="overwrite">直接覆盖 (Overwrite)</option>
              <option value="skip">跳过不传 (Skip)</option>
              <option value="rename">自动重命名 (如 name (1).ext)</option>
            </select>
          </div>
        </div>

        {/* 软件信息 */}
        <div className="settings-group">
          <div className="settings-group-title">
            <Icon name="cloud" size={15} />
            <span>关于 R2 Manager</span>
          </div>
          <div className="about-box">
            <div className="about-brand">
              <div className="brand-logo sm">
                <img src="/app-logo.png" alt="R2 Manager" width="32" height="32" />
              </div>
              <div>
                <div className="about-title">R2 Manager</div>
                <div className="about-ver">v0.1.0 · Tauri 2 + Rust Core</div>
              </div>
            </div>
            <p className="about-desc">
              专为 Cloudflare R2 打造的高性能跨平台文件管理器，提供直观的桶管理、目录导航、断点分片并发传输与历史审计。
            </p>
            <div className="about-footer">
              <button
                type="button"
                className="btn btn-ghost about-repo-btn"
                onClick={() => api.openExternalUrl("https://github.com/dodo2dodo/R2-Manger")}
                title="在默认浏览器中打开 GitHub 开源仓库"
              >
                <Icon name="github" size={14} />
                <span>GitHub 开源仓库</span>
              </button>
              <div className="about-copyright">
                MIT License · Copyright © 2026 dodo2dodo
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
