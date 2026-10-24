import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { api, errMsg, type Profile, type ProgressEvent, type UploadItem } from "./api";
import { FileBrowser } from "./components/FileBrowser";
import { ProfileModal } from "./components/ProfileModal";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal, type Settings } from "./components/SettingsModal";
import { UploadPanel, type Task } from "./components/UploadPanel";
import { Icon } from "./icons";
import { useToast } from "./ui";
import { load, save } from "./utils";

const SETTINGS_KEY = "r2m_settings";
const ACTIVE_PROFILE_KEY = "r2m_active_profile";

const defaultSettings: Settings = {
  theme: "system",
  concurrency: 3,
  conflict: "overwrite",
};

export function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string>(() => load(ACTIVE_PROFILE_KEY, ""));
  const [editingProfile, setEditingProfile] = useState<Profile | null | "new">(null);
  const [prefix, setPrefix] = useState<string>("");
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const [settings, setSettings] = useState<Settings>(() => load(SETTINGS_KEY, defaultSettings));
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  // 主题动态响应与应用
  useEffect(() => {
    const applyTheme = () => {
      const isSystemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const effectiveTheme =
        settings.theme === "system" ? (isSystemDark ? "dark" : "light") : settings.theme;
      document.documentElement.setAttribute("data-theme", effectiveTheme);
    };

    applyTheme();

    if (settings.theme === "system") {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const listener = () => applyTheme();
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    }
  }, [settings.theme]);

  // 任务队列状态
  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;

  // 拖拽悬浮状态
  const [isDragOver, setIsDragOver] = useState(false);
  const toast = useToast();

  // 速度统计采样器：{ [taskId]: { lastTime: number, lastUploaded: number, speed: number } }
  const speedStats = useRef<Record<string, { lastTime: number; lastUploaded: number; speed: number }>>({});
  const hasInitialized = useRef(false);

  // 加载配置列表
  const loadProfiles = useCallback(async () => {
    try {
      const list = await api.listProfiles();
      setProfiles(list);
      if (list.length > 0) {
        if (!hasInitialized.current) {
          hasInitialized.current = true;
          const cached = load(ACTIVE_PROFILE_KEY, undefined);
          if (cached && list.some((p) => p.id === cached)) {
            setActiveId(cached);
          } else if (cached === "") {
            // 用户主动处于断开状态
            setActiveId("");
          } else {
            setActiveId(list[0].id);
            save(ACTIVE_PROFILE_KEY, list[0].id);
          }
        } else if (activeId && !list.some((p) => p.id === activeId)) {
          setActiveId("");
          save(ACTIVE_PROFILE_KEY, "");
        }
      } else {
        setActiveId("");
        save(ACTIVE_PROFILE_KEY, "");
      }
    } catch (e) {
      toast(`加载配置失败: ${errMsg(e)}`, "error");
    }
  }, [activeId, toast]);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  const selectProfile = (id: string) => {
    setActiveId(id);
    save(ACTIVE_PROFILE_KEY, id);
    setPrefix("");
  };

  const handleDisconnect = () => {
    setActiveId("");
    save(ACTIVE_PROFILE_KEY, "");
    setPrefix("");
    toast("已断开当前存储连接", "info");
  };

  const updateSettings = (s: Settings) => {
    setSettings(s);
    save(SETTINGS_KEY, s);
  };

  // 活跃配置对象
  const activeProfile = profiles.find((p) => p.id === activeId) ?? null;

  // 存储桶多桶切换管理
  const [currentBucket, setCurrentBucket] = useState<string>("");
  const [profileBuckets, setProfileBuckets] = useState<string[]>([]);
  const [fetchingBuckets, setFetchingBuckets] = useState<boolean>(false);

  const loadBuckets = useCallback(async (profileId: string) => {
    if (!profileId) return;
    setFetchingBuckets(true);
    try {
      const list = await api.getProfileBuckets(profileId);
      setProfileBuckets(list);
    } catch {
      // 若 Token 权限仅限特定单个 Bucket，无法 list_buckets，则优雅回退
      setProfileBuckets([]);
    } finally {
      setFetchingBuckets(false);
    }
  }, []);

  useEffect(() => {
    if (activeProfile) {
      setCurrentBucket(activeProfile.bucket);
      loadBuckets(activeProfile.id);
    } else {
      setCurrentBucket("");
      setProfileBuckets([]);
    }
  }, [activeProfile?.id, loadBuckets]);

  const handleSwitchBucket = async (newBucket: string) => {
    if (!activeProfile || newBucket === currentBucket) return;
    setCurrentBucket(newBucket);
    setPrefix("");
    toast(`已切换至存储桶: ${newBucket}`, "info");
    try {
      const updated = await api.switchProfileBucket(activeProfile.id, newBucket);
      setProfiles((list) => list.map((p) => (p.id === updated.id ? updated : p)));
    } catch (e) {
      console.warn("更新默认存储桶失败:", e);
    }
  };

  // 使用 Ref 追踪最新的上传上下文状态，避免事件监听闭包过时或重复绑定
  const uploadStateRef = useRef({
    activeProfile,
    currentBucket,
    prefix,
    settings,
  });

  useEffect(() => {
    uploadStateRef.current = {
      activeProfile,
      currentBucket,
      prefix,
      settings,
    };
  }, [activeProfile, currentBucket, prefix, settings]);

  // 触发文件上传
  const triggerUpload = useCallback(
    async (rawPaths: string[]) => {
      const {
        activeProfile: profile,
        currentBucket: bucket,
        prefix: curPrefix,
        settings: curSettings,
      } = uploadStateRef.current;

      if (!profile) {
        toast("请先选择或配置存储桶", "error");
        return;
      }
      if (!rawPaths.length) return;

      const targetBucket = bucket || profile.bucket;
      if (!targetBucket) {
        toast("未指定目标存储桶", "error");
        return;
      }

      toast(`正在分析 ${rawPaths.length} 项本地路径…`, "info");
      try {
        const items = await api.expandPaths(rawPaths, curPrefix);
        if (!items.length) {
          toast("没有找到可上传的文件", "info");
          return;
        }

        const taskInfos = await api.startUploads(
          profile.id,
          items,
          curSettings.concurrency,
          curSettings.conflict,
          targetBucket
        );

        const newTasks: Task[] = taskInfos.map((t) => ({
          id: t.id,
          profileId: profile.id,
          localPath: t.localPath,
          key: t.key,
          size: t.size,
          uploaded: 0,
          status: "queued",
          error: null,
          speed: 0,
        }));

        setTasks((prev) => [...newTasks, ...prev]);
        toast(`已加入上传队列: ${newTasks.length} 个文件`, "success");
      } catch (e) {
        toast(`创建上传任务失败: ${errMsg(e)}`, "error");
      }
    },
    [toast]
  );

  const triggerUploadRef = useRef(triggerUpload);
  triggerUploadRef.current = triggerUpload;

  // 监听 Tauri 窗口原生拖拽事件（仅在组件挂载时注册一次，防重复绑定与竞态泄露）
  useEffect(() => {
    let isMounted = true;
    let unlistenFn: (() => void) | null = null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!isMounted) return;
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setIsDragOver(true);
        } else if (event.payload.type === "leave") {
          setIsDragOver(false);
        } else if (event.payload.type === "drop") {
          setIsDragOver(false);
          const paths = event.payload.paths;
          if (paths && paths.length > 0) {
            triggerUploadRef.current(paths);
          }
        }
      })
      .then((fn) => {
        if (!isMounted) {
          fn();
        } else {
          unlistenFn = fn;
        }
      })
      .catch((err) => {
        console.warn("绑定拖拽事件失败:", err);
      });

    return () => {
      isMounted = false;
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // 监听 Rust 发出的上传进度事件
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<ProgressEvent>("upload://progress", (e) => {
      const payload = e.payload;
      const now = performance.now();
      const st = speedStats.current[payload.id] ?? {
        lastTime: now,
        lastUploaded: payload.uploaded,
        speed: 0,
      };

      const dt = (now - st.lastTime) / 1000;
      let curSpeed = st.speed;
      if (dt >= 0.4) {
        const dBytes = Math.max(0, payload.uploaded - st.lastUploaded);
        curSpeed = Math.round(dBytes / dt);
        speedStats.current[payload.id] = {
          lastTime: now,
          lastUploaded: payload.uploaded,
          speed: curSpeed,
        };
      }

      setTasks((list) =>
        list.map((t) => {
          if (t.id !== payload.id) return t;
          return {
            ...t,
            status: payload.status,
            uploaded: payload.uploaded,
            key: payload.key,
            error: payload.error,
            speed: payload.status === "uploading" ? curSpeed : 0,
          };
        })
      );

      // 上传完成后刷新浏览器列表
      if (payload.status === "done") {
        setRefreshKey((k) => k + 1);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 任务队列操作
  const handleCancel = (id: string) => {
    api.cancelUpload(id).catch(console.error);
  };

  const handleCancelAll = () => {
    api.cancelAllUploads().catch(console.error);
  };

  const handleClear = () => {
    setTasks((list) =>
      list.filter((t) => t.status === "uploading" || t.status === "queued")
    );
  };

  const handleRetry = (t: Task) => {
    if (!activeProfile) return;
    const item: UploadItem = {
      localPath: t.localPath,
      key: t.key,
      size: t.size,
    };
    api
      .startUploads(activeProfile.id, [item], settings.concurrency, settings.conflict)
      .then(([info]) => {
        setTasks((list) =>
          list.map((old) =>
            old.id === t.id
              ? {
                  ...old,
                  id: info.id,
                  status: "queued",
                  uploaded: 0,
                  error: null,
                  speed: 0,
                }
              : old
          )
        );
      })
      .catch((e) => toast(`重试失败: ${errMsg(e)}`, "error"));
  };

  const handleRetryFailed = () => {
    const failed = tasks.filter((t) => t.status === "error");
    failed.forEach(handleRetry);
  };

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  // 监听快捷键 Cmd+B / Ctrl+B 快速切换侧边栏
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setIsSidebarCollapsed((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="layout-root">
      <Sidebar
        profiles={profiles}
        activeId={activeId}
        onSelect={selectProfile}
        onAdd={() => setEditingProfile("new")}
        onEdit={(p) => setEditingProfile(p)}
        onDisconnect={handleDisconnect}
        settings={settings}
        onSettings={updateSettings}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed((prev) => !prev)}
      />

      <main className="layout-main">
        {activeProfile ? (
          <FileBrowser
            profile={activeProfile}
            currentBucket={currentBucket || activeProfile.bucket}
            availableBuckets={profileBuckets}
            onSelectBucket={handleSwitchBucket}
            onRefreshBuckets={() => loadBuckets(activeProfile.id)}
            fetchingBuckets={fetchingBuckets}
            prefix={prefix}
            setPrefix={setPrefix}
            refreshKey={refreshKey}
            onUploadPaths={triggerUpload}
            isSidebarCollapsed={isSidebarCollapsed}
            onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
          />
        ) : (
          <div className="no-profile-view">
            <div className="empty-card">
              <div className="empty-card-logo">
                <img src="/app-logo.png" alt="R2 Manager" width="68" height="68" />
              </div>
              {profiles.length > 0 ? (
                <>
                  <h2>未连接存储配置</h2>
                  <p>当前未连接任何存储桶。请从左侧存储列表中选择配置连接，或添加新配置。</p>
                  <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "center" }}>
                    <button
                      className="btn btn-primary"
                      onClick={() => selectProfile(profiles[0].id)}
                    >
                      <Icon name="database" size={14} /> 连接「{profiles[0].name || profiles[0].bucket}」
                    </button>
                    <button
                      className="btn"
                      onClick={() => setEditingProfile("new")}
                    >
                      <Icon name="plus" size={14} /> 添加新配置
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h2>欢迎使用 R2 Manager</h2>
                  <p>请先添加一个 Cloudflare R2 存储桶配置以开始管理文件</p>
                  <button
                    className="btn btn-primary"
                    onClick={() => setEditingProfile("new")}
                    style={{ marginTop: 16 }}
                  >
                    <Icon name="plus" /> 添加第一个配置
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        <UploadPanel
          tasks={tasks}
          onCancel={handleCancel}
          onCancelAll={handleCancelAll}
          onClear={handleClear}
          onRetry={handleRetry}
          onRetryFailed={handleRetryFailed}
        />
      </main>

      {/* 全局拖拽悬停遮罩 */}
      {isDragOver && (
        <div className="drag-overlay">
          <div className="drag-box">
            <div className="drag-icon-pulse">
              <Icon name="upload" size={44} />
            </div>
            <h2>松开鼠标立即上传</h2>
            <p>
              将上传至当前目录：
              <span className="drag-path">
                {activeProfile ? `/${currentBucket || activeProfile.bucket}/${prefix}` : "请先配置 Bucket"}
              </span>
            </p>
          </div>
        </div>
      )}

      {/* 配置模态窗 */}
      {editingProfile !== null && (
        <ProfileModal
          profile={editingProfile === "new" ? null : editingProfile}
          onClose={() => setEditingProfile(null)}
          onSaved={(saved) => {
            setEditingProfile(null);
            loadProfiles().then(() => selectProfile(saved.id));
          }}
          onDeleted={(id) => {
            setEditingProfile(null);
            loadProfiles();
            if (activeId === id) {
              setActiveId("");
              save(ACTIVE_PROFILE_KEY, "");
            }
          }}
        />
      )}

      {/* 设置模态窗 */}
      {isSettingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={updateSettings}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </div>
  );
}
