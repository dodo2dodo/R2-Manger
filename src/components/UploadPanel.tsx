import { useMemo, useState } from "react";
import type { UploadStatus } from "../api";
import { Icon } from "../icons";
import { baseName, fileKind, formatBytes } from "../utils";

export interface Task {
  id: string;
  profileId: string;
  localPath: string;
  key: string;
  size: number;
  uploaded: number;
  status: UploadStatus;
  error: string | null;
  speed: number;
}

const ORDER: Record<UploadStatus, number> = { uploading: 0, error: 1, queued: 2, canceled: 3, skipped: 4, done: 5 };
const LABEL: Record<UploadStatus, string> = {
  queued: "等待中",
  uploading: "上传中",
  done: "完成",
  error: "失败",
  canceled: "已取消",
  skipped: "已跳过",
};
const MAX_RENDER = 300;

export function UploadPanel({
  tasks,
  onCancel,
  onCancelAll,
  onClear,
  onRetry,
  onRetryFailed,
}: {
  tasks: Task[];
  onCancel: (id: string) => void;
  onCancelAll: () => void;
  onClear: () => void;
  onRetry: (t: Task) => void;
  onRetryFailed: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<"all" | "active" | "error">("all");

  const stats = useMemo(() => {
    let total = 0,
      uploaded = 0,
      speed = 0,
      active = 0,
      done = 0,
      failed = 0;
    for (const t of tasks) {
      if (t.status === "canceled" || t.status === "skipped") continue;
      total += t.size;
      uploaded += t.status === "done" ? t.size : t.uploaded;
      if (t.status === "uploading") speed += t.speed;
      if (t.status === "uploading" || t.status === "queued") active++;
      if (t.status === "done") done++;
      if (t.status === "error") failed++;
    }
    return { total, uploaded, speed, active, done, failed, pct: total ? (uploaded / total) * 100 : 100 };
  }, [tasks]);

  const list = useMemo(() => {
    const f = tasks.filter((t) =>
      filter === "all" ? true : filter === "active" ? t.status === "uploading" || t.status === "queued" : t.status === "error",
    );
    return f.sort((a, b) => ORDER[a.status] - ORDER[b.status]).slice(0, MAX_RENDER);
  }, [tasks, filter]);

  if (!tasks.length) return null;

  const eta = stats.speed > 0 ? Math.round((stats.total - stats.uploaded) / stats.speed) : 0;
  const etaText = eta > 3600 ? `${Math.floor(eta / 3600)} 时 ${Math.round((eta % 3600) / 60)} 分` : eta > 60 ? `${Math.floor(eta / 60)} 分 ${eta % 60} 秒` : `${eta} 秒`;

  return (
    <div className={`upanel ${collapsed ? "collapsed" : ""}`}>
      <div className="upanel-head" onClick={() => setCollapsed(!collapsed)}>
        <div className="upanel-title">
          {stats.active > 0 ? (
            <span className="pulse-dot" />
          ) : stats.failed > 0 ? (
            <Icon name="alert" size={15} className="danger-text" />
          ) : (
            <Icon name="check" size={15} className="ok-text" />
          )}
          <span>
            {stats.active > 0 ? `正在上传 ${stats.done}/${tasks.length}` : stats.failed ? `${stats.failed} 个文件上传失败` : "全部上传完成"}
          </span>
        </div>
        <div className="upanel-sub">
          {stats.active > 0 && (
            <>
              <span>{formatBytes(stats.speed)}/s</span>
              {eta > 0 && <span>剩余 {etaText}</span>}
            </>
          )}
          <button className="icon-btn sm" aria-label="折叠">
            <Icon name="chevronDown" size={14} className={collapsed ? "flip" : ""} />
          </button>
        </div>
        <div className="upanel-bar">
          <div className="upanel-bar-fill" style={{ width: `${stats.pct}%` }} />
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="upanel-tools">
            <div className="seg sm">
              {(
                [
                  ["all", `全部 ${tasks.length}`],
                  ["active", `进行中 ${stats.active}`],
                  ["error", `失败 ${stats.failed}`],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={`seg-item ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="upanel-btns">
              {stats.failed > 0 && (
                <button className="icon-btn sm" title="重试全部失败" onClick={onRetryFailed}>
                  <Icon name="retry" size={14} />
                </button>
              )}
              {stats.active > 0 && (
                <button className="icon-btn sm" title="全部取消" onClick={onCancelAll}>
                  <Icon name="x" size={14} />
                </button>
              )}
              <button className="icon-btn sm" title="清除已结束" onClick={onClear}>
                <Icon name="broom" size={14} />
              </button>
            </div>
          </div>
          <div className="upanel-list">
            {list.map((t) => {
              const pct = t.status === "done" ? 100 : t.size ? (t.uploaded / t.size) * 100 : 0;
              return (
                <div key={t.id} className={`utask s-${t.status}`}>
                  <span className={`ficon sm k-${fileKind(t.key)}`}>
                    <Icon name={fileKind(t.key)} size={14} />
                  </span>
                  <div className="utask-main">
                    <div className="utask-name" title={t.key}>
                      {baseName(t.key)}
                    </div>
                    <div className="utask-meta">
                      {t.status === "error" ? (
                        <span className="danger-text utask-err" title={t.error ?? ""}>
                          {t.error}
                        </span>
                      ) : t.status === "uploading" ? (
                        <span>
                          {formatBytes(t.uploaded)} / {formatBytes(t.size)}
                          {t.speed > 0 && ` · ${formatBytes(t.speed)}/s`}
                        </span>
                      ) : (
                        <span>
                          {formatBytes(t.size)} · {LABEL[t.status]}
                        </span>
                      )}
                    </div>
                    {(t.status === "uploading" || t.status === "queued") && (
                      <div className="mini-bar">
                        <div className="mini-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="utask-act">
                    {t.status === "done" && <Icon name="check" size={15} className="ok-text" />}
                    {t.status === "skipped" && <Icon name="skip" size={14} className="muted" />}
                    {(t.status === "error" || t.status === "canceled") && (
                      <button className="icon-btn sm" title="重试" onClick={() => onRetry(t)}>
                        <Icon name="retry" size={14} />
                      </button>
                    )}
                    {(t.status === "uploading" || t.status === "queued") && (
                      <button className="icon-btn sm" title="取消" onClick={() => onCancel(t.id)}>
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {tasks.length > MAX_RENDER && list.length === MAX_RENDER && (
              <div className="upanel-more">仅显示前 {MAX_RENDER} 项</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
