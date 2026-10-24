import { useState, useEffect, useMemo } from "react";
import { Icon } from "../icons";
import { Modal, useToast } from "../ui";
import {
  getOperationHistory,
  clearOperationHistory,
  removeOperationRecord,
  type OperationRecord,
  type OperationType,
} from "../history";
import { formatTime } from "../utils";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export function OperationHistoryModal({ onClose }: { onClose: () => void }) {
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [filter, setFilter] = useState<"all" | OperationType>("all");
  const [query, setQuery] = useState("");
  const toast = useToast();

  const loadData = () => {
    setRecords(getOperationHistory());
  };

  useEffect(() => {
    loadData();
    const handleUpdate = () => loadData();
    window.addEventListener("r2_operation_history_changed", handleUpdate);
    return () => {
      window.removeEventListener("r2_operation_history_changed", handleUpdate);
    };
  }, []);

  const handleClearAll = () => {
    if (!records.length) return;
    if (window.confirm("确定清除所有本地操作记录吗？此操作仅删除本地日志，完全不影响云端和本地文件。")) {
      clearOperationHistory();
      toast("已清空所有操作记录", "success");
    }
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await writeText(text);
      toast(`已复制${label}: ${text}`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const filtered = useMemo(() => {
    return records.filter((r) => {
      if (filter !== "all" && r.type !== filter) return false;
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      if (r.bucket.toLowerCase().includes(q)) return true;
      if (r.summary.toLowerCase().includes(q)) return true;
      if (r.details.oldPath && r.details.oldPath.toLowerCase().includes(q)) return true;
      if (r.details.newPath && r.details.newPath.toLowerCase().includes(q)) return true;
      if (r.details.paths && r.details.paths.some((p) => p.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [records, filter, query]);

  const typeMeta = (type: OperationType) => {
    switch (type) {
      case "delete":
        return { label: "删除", color: "danger", icon: "trash" as const };
      case "rename":
        return { label: "重命名", color: "primary", icon: "edit" as const };
      case "create_folder":
        return { label: "新建文件夹", color: "success", icon: "folderPlus" as const };
    }
  };

  return (
    <Modal
      title="操作历史记录"
      onClose={onClose}
      width={680}
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", alignItems: "center" }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
            共记录 {records.length} 项操作
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {records.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ color: "var(--color-danger, #ef4444)" }}
                onClick={handleClearAll}
              >
                <Icon name="broom" size={14} /> 清空全部记录
              </button>
            )}
            <button type="button" className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </div>
      }
    >
      <div className="op-history-wrap">
        {/* 工具栏：搜索与筛选 */}
        <div className="op-history-tools">
          <div className="seg sm">
            <button
              type="button"
              className={`seg-item ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              全部 ({records.length})
            </button>
            <button
              type="button"
              className={`seg-item ${filter === "delete" ? "active" : ""}`}
              onClick={() => setFilter("delete")}
            >
              删除 ({records.filter((r) => r.type === "delete").length})
            </button>
            <button
              type="button"
              className={`seg-item ${filter === "rename" ? "active" : ""}`}
              onClick={() => setFilter("rename")}
            >
              重命名 ({records.filter((r) => r.type === "rename").length})
            </button>
            <button
              type="button"
              className={`seg-item ${filter === "create_folder" ? "active" : ""}`}
              onClick={() => setFilter("create_folder")}
            >
              新建 ({records.filter((r) => r.type === "create_folder").length})
            </button>
          </div>

          <div className="search op-history-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              placeholder="搜索记录路径或文件名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {query && (
              <button className="icon-btn sm" onClick={() => setQuery("")}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        </div>

        {/* 记录列表 */}
        <div className="op-history-list">
          {filtered.length === 0 ? (
            <div className="op-history-empty">
              <Icon name="history" size={32} />
              <div className="op-empty-title">
                {records.length === 0 ? "暂无操作记录" : "未找到匹配的记录"}
              </div>
              <p>
                {records.length === 0
                  ? "当您在软件中执行删除、重命名或新建文件夹时，相关操作均会清晰记录于此，方便快速纠错与回溯原路径。"
                  : "尝试更换搜索关键字或切换上方筛选状态。"}
              </p>
            </div>
          ) : (
            filtered.map((r) => {
              const meta = typeMeta(r.type);
              return (
                <div key={r.id} className="op-card">
                  <div className="op-card-head">
                    <span className={`op-badge ${meta.color}`}>
                      <Icon name={meta.icon} size={12} />
                      {meta.label}
                    </span>
                    <span className="op-bucket-tag">桶: {r.bucket}</span>
                    <span className="op-time">{formatTime(r.timestamp)}</span>
                    <button
                      type="button"
                      className="icon-btn sm op-del-btn"
                      title="移除此条记录"
                      onClick={() => removeOperationRecord(r.id)}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </div>

                  <div className="op-card-body">
                    {/* 重命名详情展示：原名称 -> 新名称 */}
                    {r.type === "rename" && (
                      <div className="op-rename-box">
                        <div className="op-path-row">
                          <span className="op-path-label old">原路径:</span>
                          <span className="op-path-val mono">{r.details.oldPath}</span>
                          <button
                            type="button"
                            className="icon-btn sm"
                            title="复制原路径"
                            onClick={() => handleCopy(r.details.oldPath || "", "原路径")}
                          >
                            <Icon name="copy" size={12} />
                          </button>
                        </div>
                        <div className="op-rename-arrow">
                          <Icon name="chevronDown" size={13} />
                        </div>
                        <div className="op-path-row">
                          <span className="op-path-label new">新路径:</span>
                          <span className="op-path-val mono">{r.details.newPath}</span>
                          <button
                            type="button"
                            className="icon-btn sm"
                            title="复制新路径"
                            onClick={() => handleCopy(r.details.newPath || "", "新路径")}
                          >
                            <Icon name="copy" size={12} />
                          </button>
                        </div>
                      </div>
                    )}

                    {/* 删除详情展示：列出删除的路径 */}
                    {r.type === "delete" && (
                      <div className="op-delete-box">
                        <div className="op-summary">{r.summary}</div>
                        <div className="op-path-list">
                          {r.details.paths?.map((p, idx) => (
                            <div key={idx} className="op-path-row">
                              <span className="op-path-bullet">•</span>
                              <span className="op-path-val mono">{p}</span>
                              <button
                                type="button"
                                className="icon-btn sm"
                                title="复制已删除路径"
                                onClick={() => handleCopy(p, "已删除路径")}
                              >
                                <Icon name="copy" size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* 新建文件夹详情展示 */}
                    {r.type === "create_folder" && (
                      <div className="op-path-row">
                        <span className="op-path-label">创建路径:</span>
                        <span className="op-path-val mono">{r.details.newPath}</span>
                        <button
                          type="button"
                          className="icon-btn sm"
                          title="复制路径"
                          onClick={() => handleCopy(r.details.newPath || "", "路径")}
                        >
                          <Icon name="copy" size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </Modal>
  );
}
