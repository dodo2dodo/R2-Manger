import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Profile } from "../api";
import { Icon } from "../icons";
import type { Settings, ThemeMode } from "./SettingsModal";

export function Sidebar({
  profiles,
  activeId,
  onSelect,
  onAdd,
  onEdit,
  onDisconnect,
  settings,
  onSettings,
  onOpenSettings,
  isCollapsed = false,
  onToggleCollapse,
}: {
  profiles: Profile[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onEdit: (p: Profile) => void;
  onDisconnect?: () => void;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onOpenSettings: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    profile: Profile;
  } | null>(null);

  useEffect(() => {
    const handleClose = () => setContextMenu(null);
    window.addEventListener("click", handleClose);
    window.addEventListener("contextmenu", handleClose);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("contextmenu", handleClose);
    };
  }, []);

  const switchTheme = (theme: ThemeMode) => {
    onSettings({ ...settings, theme });
  };

  return (
    <aside className={`sidebar ${isCollapsed ? "collapsed" : ""}`}>
      <div className="brand">
        <div className="brand-logo" title="R2 Manager">
          <img src="/app-logo.png" alt="R2 Manager" width="34" height="34" />
        </div>
        <div className="brand-text">
          <div className="brand-name">R2 Manager</div>
          <div className="brand-sub">Cloudflare R2 客户端</div>
        </div>
        {onToggleCollapse && (
          <button
            type="button"
            className="icon-btn sm sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title="收起侧边栏 (Cmd+B)"
            aria-label="收起侧边栏"
          >
            <Icon name="sidebar" size={14} />
          </button>
        )}
      </div>

      <div className="side-section">
        <div className="side-title">
          <span>存储配置</span>
          <button className="icon-btn sm" onClick={onAdd} title="添加配置" id="btn-add-profile">
            <Icon name="plus" size={14} />
          </button>
        </div>
        <nav className="profile-list">
          {profiles.map((p) => (
            <div
              key={p.id}
              className={`profile-item ${p.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(p.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                onEdit(p);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  profile: p,
                });
              }}
              title={`${p.name || p.bucket} (双击编辑，右键更多)`}
            >
              <div className="profile-icon">
                <Icon name="database" size={15} />
              </div>
              <div className="profile-meta">
                <div className="profile-name">{p.name || p.bucket}</div>
                <div className="profile-bucket">{p.bucket}</div>
              </div>
              <div className="profile-actions">
                {p.id === activeId && onDisconnect && (
                  <button
                    type="button"
                    className="icon-btn sm profile-action-btn profile-disconnect"
                    title="断开当前连接"
                    aria-label="断开当前连接"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDisconnect();
                    }}
                  >
                    <Icon name="unlink" size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn sm profile-action-btn profile-edit"
                  title="编辑配置"
                  aria-label="编辑配置"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(p);
                  }}
                >
                  <Icon name="edit" size={13} />
                </button>
              </div>
            </div>
          ))}
          {profiles.length === 0 && <div className="side-empty">暂无配置</div>}
        </nav>
      </div>

      {contextMenu &&
        createPortal(
          <div
            className="row-context-menu"
            style={{
              position: "fixed",
              left: Math.min(contextMenu.x, window.innerWidth - 180),
              top: Math.min(contextMenu.y, window.innerHeight - 130),
              zIndex: 99999,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="context-menu-header">
              {contextMenu.profile.name || contextMenu.profile.bucket}
            </div>
            {contextMenu.profile.id === activeId ? (
              <button
                type="button"
                className="context-menu-item danger"
                onClick={() => {
                  setContextMenu(null);
                  onDisconnect?.();
                }}
              >
                <Icon name="unlink" size={14} />
                <span>断开连接</span>
              </button>
            ) : (
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setContextMenu(null);
                  onSelect(contextMenu.profile.id);
                }}
              >
                <Icon name="database" size={14} />
                <span>连接此存储</span>
              </button>
            )}
            <div className="context-menu-divider" />
            <button
              type="button"
              className="context-menu-item"
              onClick={() => {
                setContextMenu(null);
                onEdit(contextMenu.profile);
              }}
            >
              <Icon name="edit" size={14} />
              <span>编辑配置…</span>
            </button>
          </div>,
          document.body
        )}

      <div className="side-footer">
        {/* 左侧：外观模式快速切换 */}
        <div className="theme-toggle-pill">
          <button
            type="button"
            className={`theme-toggle-btn ${settings.theme === "light" ? "active" : ""}`}
            title="浅色模式"
            onClick={() => switchTheme("light")}
          >
            <Icon name="sun" size={14} />
          </button>
          <button
            type="button"
            className={`theme-toggle-btn ${settings.theme === "dark" ? "active" : ""}`}
            title="深色模式"
            onClick={() => switchTheme("dark")}
          >
            <Icon name="moon" size={14} />
          </button>
          <button
            type="button"
            className={`theme-toggle-btn ${settings.theme === "system" ? "active" : ""}`}
            title="跟随系统"
            onClick={() => switchTheme("system")}
          >
            <Icon name="monitor" size={14} />
          </button>
        </div>

        {/* 最右侧：设置 */}
        <button
          type="button"
          className="side-settings-btn"
          onClick={onOpenSettings}
          title="设置与首选项"
          aria-label="设置与首选项"
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </aside>
  );
}
