import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api, errMsg, type FileEntry, type Profile } from "../api";
import { Icon } from "../icons";
import { Modal, useDialog, useToast } from "../ui";
import { baseName, fileKind, formatBytes, formatTime, publicUrl } from "../utils";
import { addOperationRecord } from "../history";
import { OperationHistoryModal } from "./OperationHistoryModal";

interface Row {
  key: string;
  name: string;
  lowerName: string;
  isDir: boolean;
  size: number;
  lastModified: number;
}

type SortKey = "name" | "size" | "time";

// 目录切换内存缓存（90秒内秒级切换）
interface DirCacheEntry {
  folders: string[];
  files: FileEntry[];
  nextToken: string | null;
  timestamp: number;
}
const dirCache = new Map<string, DirCacheEntry>();
const CACHE_TTL = 90 * 1000;

export function FileBrowser({
  profile,
  currentBucket,
  availableBuckets = [],
  onSelectBucket,
  onRefreshBuckets,
  fetchingBuckets = false,
  prefix,
  setPrefix,
  refreshKey,
  onUploadPaths,
  isSidebarCollapsed = false,
  onToggleSidebar,
}: {
  profile: Profile;
  currentBucket: string;
  availableBuckets?: string[];
  onSelectBucket: (b: string) => void;
  onRefreshBuckets: () => void;
  fetchingBuckets?: boolean;
  prefix: string;
  setPrefix: (p: string) => void;
  refreshKey: number;
  onUploadPaths: (paths: string[]) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}) {
  const [folders, setFolders] = useState<string[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [presignKey, setPresignKey] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const loadSeq = useRef(0);
  const abortLoadAllRef = useRef(false);
  const toast = useToast();
  const dialog = useDialog();

  // 搜索输入 120ms 防抖，避免按键卡顿
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim().toLowerCase());
    }, 120);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 虚拟滚动与视口尺寸
  const tbodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  // 监听表格容器高度变化
  useEffect(() => {
    const el = tbodyRef.current;
    if (!el) return;
    const updateSize = () => setViewportHeight(el.clientHeight || 600);
    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 存储桶下拉选择浮层状态
  const [isBucketOpen, setIsBucketOpen] = useState(false);
  const [bucketSearch, setBucketSearch] = useState("");
  const bucketMenuRef = useRef<HTMLDivElement>(null);

  // 现代化桌面原生右键上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: Row } | null>(null);

  useEffect(() => {
    const handleClose = () => setContextMenu(null);
    window.addEventListener("click", handleClose);
    window.addEventListener("resize", handleClose);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("resize", handleClose);
    };
  }, []);

  // 确保有效 Bucket 名称
  const activeBucket = currentBucket || profile.bucket;

  // 监听点击外部关闭存储桶下拉
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (bucketMenuRef.current && !bucketMenuRef.current.contains(e.target as Node)) {
        setIsBucketOpen(false);
      }
    };
    if (isBucketOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isBucketOpen]);

  // 加载对象列表（支持 90 秒 LRU 目录缓存，实现目录切换 0ms 闪开）
  const load = useCallback(
    async (forceRefresh = false) => {
      if (!activeBucket) return;
      const seq = ++loadSeq.current;
      abortLoadAllRef.current = true;
      setLoadingAll(false);

      const cacheKey = `${profile.id}:${activeBucket}:${prefix}`;
      const cached = dirCache.get(cacheKey);

      // 如果未要求强制刷新，且有未过期缓存，瞬时秒开渲染
      if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        setFolders(cached.folders);
        setFiles(cached.files);
        setNextToken(cached.nextToken);
        setLoading(false);
        setError("");
        return;
      }

      setLoading(true);
      setError("");
      setNextToken(null);
      try {
        const r = await api.listObjects(profile.id, prefix, null, activeBucket);
        if (seq !== loadSeq.current) return;
        setFolders(r.folders);
        setFiles(r.files);
        setNextToken(r.nextToken);
        dirCache.set(cacheKey, {
          folders: r.folders,
          files: r.files,
          nextToken: r.nextToken,
          timestamp: Date.now(),
        });
      } catch (e) {
        if (seq === loadSeq.current) setError(errMsg(e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [profile.id, prefix, activeBucket]
  );

  // 加载下一页（触底自动触发，并同步更新目录缓存）
  const loadMore = useCallback(async () => {
    if (!activeBucket || !nextToken || loading || loadingMore || loadingAll) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    const cacheKey = `${profile.id}:${activeBucket}:${prefix}`;
    try {
      const r = await api.listObjects(profile.id, prefix, nextToken, activeBucket);
      if (seq !== loadSeq.current) return;
      let nextFolders: string[] = [];
      let nextFiles: FileEntry[] = [];
      setFolders((prev) => {
        nextFolders = Array.from(new Set([...prev, ...r.folders]));
        return nextFolders;
      });
      setFiles((prev) => {
        const map = new Map<string, FileEntry>();
        for (const f of prev) map.set(f.key, f);
        for (const f of r.files) map.set(f.key, f);
        nextFiles = Array.from(map.values());
        return nextFiles;
      });
      setNextToken(r.nextToken);
      dirCache.set(cacheKey, {
        folders: nextFolders,
        files: nextFiles,
        nextToken: r.nextToken,
        timestamp: Date.now(),
      });
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setLoadingMore(false);
    }
  }, [activeBucket, nextToken, loading, loadingMore, loadingAll, profile.id, prefix, toast]);

  // 全部加载（针对超大目录用户需要全部拉取）
  const loadAll = useCallback(async () => {
    if (!activeBucket || !nextToken || loading || loadingMore || loadingAll) return;
    const seq = loadSeq.current;
    setLoadingAll(true);
    abortLoadAllRef.current = false;
    let curToken: string | null = nextToken;
    const cacheKey = `${profile.id}:${activeBucket}:${prefix}`;
    try {
      while (curToken && !abortLoadAllRef.current && seq === loadSeq.current) {
        const r = await api.listObjects(profile.id, prefix, curToken, activeBucket);
        if (seq !== loadSeq.current || abortLoadAllRef.current) break;
        let nextFolders: string[] = [];
        let nextFiles: FileEntry[] = [];
        setFolders((prev) => {
          nextFolders = Array.from(new Set([...prev, ...r.folders]));
          return nextFolders;
        });
        setFiles((prev) => {
          const map = new Map<string, FileEntry>();
          for (const f of prev) map.set(f.key, f);
          for (const f of r.files) map.set(f.key, f);
          nextFiles = Array.from(map.values());
          return nextFiles;
        });
        curToken = r.nextToken;
        setNextToken(r.nextToken);
        dirCache.set(cacheKey, {
          folders: nextFolders,
          files: nextFiles,
          nextToken: r.nextToken,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setLoadingAll(false);
    }
  }, [activeBucket, nextToken, loading, loadingMore, loadingAll, profile.id, prefix, toast]);

  const stopLoadAll = () => {
    abortLoadAllRef.current = true;
    setLoadingAll(false);
  };

  useEffect(() => {
    setSelected(new Set());
    setSearchInput("");
    setSearch("");
    setFolders([]);
    setFiles([]);
    setNextToken(null);
    if (tbodyRef.current) tbodyRef.current.scrollTop = 0;
    setScrollTop(0);
    load();
  }, [load]);

  useEffect(() => {
    if (refreshKey) {
      const cacheKey = `${profile.id}:${activeBucket}:${prefix}`;
      dirCache.delete(cacheKey);
      load(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // 存储桶列表（如果后端拉到了列表，且里面没有当前的，则补齐）
  const allBuckets = useMemo(() => {
    const list = [...availableBuckets];
    if (activeBucket && !list.includes(activeBucket)) {
      list.unshift(activeBucket);
    }
    return list;
  }, [availableBuckets, activeBucket]);

  // 存储桶过滤
  const filteredBuckets = useMemo(() => {
    const q = bucketSearch.trim().toLowerCase();
    if (!q) return allBuckets;
    return allBuckets.filter((b) => b.toLowerCase().includes(q));
  }, [allBuckets, bucketSearch]);

  const rows: Row[] = useMemo(() => {
    const q = search;
    const dirs: Row[] = folders.map((k) => {
      const name = baseName(k);
      return { key: k, name, lowerName: name.toLowerCase(), isDir: true, size: 0, lastModified: 0 };
    });
    const fls: Row[] = files.map((f) => {
      const name = baseName(f.key);
      return { key: f.key, name, lowerName: name.toLowerCase(), isDir: false, size: f.size, lastModified: f.lastModified };
    });
    const dir = sort.asc ? 1 : -1;
    const cmp = (a: Row, b: Row) => {
      if (sort.key === "size") return (a.size - b.size) * dir;
      if (sort.key === "time") return (a.lastModified - b.lastModified) * dir;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true }) * dir;
    };
    const filt = (r: Row) => !q || r.lowerName.includes(q);
    return [...dirs.filter(filt).sort(cmp), ...fls.filter(filt).sort(cmp)];
  }, [folders, files, search, sort]);

  const totalSize = useMemo(() => files.reduce((s, f) => s + f.size, 0), [files]);

  // 虚拟列表参数（固定单行高度 38px）
  const ROW_HEIGHT = 38;
  const OVERSCAN = 10;
  const totalRows = rows.length;
  const totalVirtualHeight = totalRows * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(totalRows, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = useMemo(() => {
    return rows.slice(startIndex, endIndex).map((r, i) => ({
      item: r,
      top: (startIndex + i) * ROW_HEIGHT,
    }));
  }, [rows, startIndex, endIndex]);

  // 滚动监听与触底无限加载
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 350) {
      if (nextToken && !loading && !loadingMore && !loadingAll) {
        loadMore();
      }
    }
  };

  const crumbs = useMemo(() => {
    const parts = prefix.split("/").filter(Boolean);
    return parts.map((p, i) => ({ name: p, prefix: parts.slice(0, i + 1).join("/") + "/" }));
  }, [prefix]);

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.key));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.key)));

  const setSortKey = (key: SortKey) => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }));

  /* ---------------- actions ---------------- */

  const pickFiles = async (directory: boolean) => {
    const r = await open({ multiple: true, directory });
    if (!r) return;
    onUploadPaths(Array.isArray(r) ? r : [r]);
  };

  const invalidateCurrentCache = () => {
    const cacheKey = `${profile.id}:${activeBucket}:${prefix}`;
    dirCache.delete(cacheKey);
  };

  const newFolder = async () => {
    const name = await dialog.prompt({ title: "新建文件夹", placeholder: "文件夹名称" });
    if (!name) return;
    try {
      const createdPath = prefix + name.replace(/^\/+|\/+$/g, "");
      await api.createFolder(profile.id, createdPath, activeBucket);
      addOperationRecord({
        type: "create_folder",
        bucket: activeBucket,
        profileId: profile.id,
        summary: `创建文件夹「${name}」`,
        details: {
          newPath: createdPath,
        },
      });
      toast("已创建文件夹", "success");
      invalidateCurrentCache();
      load(true);
    } catch (e) {
      toast(errMsg(e), "error");
    }
  };

  const remove = async (keys: string[]) => {
    if (!keys.length) return;
    const hasDir = keys.some((k) => k.endsWith("/"));
    const ok = await dialog.confirm({
      title: "确认删除",
      message:
        keys.length === 1
          ? `确定删除「${baseName(keys[0])}」${hasDir ? "及其中所有文件" : ""}吗？此操作不可恢复。`
          : `确定删除选中的 ${keys.length} 项${hasDir ? "（包含文件夹内所有文件）" : ""}吗？此操作不可恢复。`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    setBusy("正在删除…");
    try {
      const n = await api.deleteObjects(profile.id, keys, activeBucket);
      addOperationRecord({
        type: "delete",
        bucket: activeBucket,
        profileId: profile.id,
        summary:
          keys.length === 1
            ? `删除「${baseName(keys[0])}」`
            : `批量删除 ${keys.length} 项 (${n} 个对象)`,
        details: {
          paths: keys,
        },
      });
      toast(`已删除 ${n} 个对象`, "success");
      setSelected(new Set());
      invalidateCurrentCache();
      load(true);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const rename = async (row: Row) => {
    const name = await dialog.prompt({
      title: row.isDir ? "重命名文件夹" : "重命名",
      value: row.name,
      message: "可输入包含 / 的路径以移动到子目录",
    });
    if (!name || name === row.name) return;
    const to = prefix + name.replace(/^\/+/, "") + (row.isDir && !name.endsWith("/") ? "/" : "");
    setBusy("正在重命名…");
    try {
      await api.renameObject(profile.id, row.key, to, activeBucket);
      addOperationRecord({
        type: "rename",
        bucket: activeBucket,
        profileId: profile.id,
        summary: `重命名「${row.name}」`,
        details: {
          oldPath: row.key,
          newPath: to,
          name: row.name,
        },
      });
      toast("重命名成功", "success");
      invalidateCurrentCache();
      load(true);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const download = async (keys: string[]) => {
    const fileKeys = keys.filter((k) => !k.endsWith("/"));
    if (!fileKeys.length) return toast("暂不支持直接下载文件夹", "info");
    try {
      if (fileKeys.length === 1) {
        const dest = await save({ defaultPath: baseName(fileKeys[0]) });
        if (!dest) return;
        setBusy("正在下载…");
        await api.downloadObject(profile.id, fileKeys[0], dest, activeBucket);
      } else {
        const dir = await open({ directory: true, title: "选择保存目录" });
        if (!dir || Array.isArray(dir)) return;
        const sep = dir.includes("\\") ? "\\" : "/";
        for (let i = 0; i < fileKeys.length; i++) {
          setBusy(`正在下载 ${i + 1}/${fileKeys.length}…`);
          await api.downloadObject(profile.id, fileKeys[i], `${dir}${sep}${baseName(fileKeys[i])}`, activeBucket);
        }
      }
      toast("下载完成", "success");
    } catch (e) {
      toast(`下载失败：${errMsg(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  const copyLink = async (key: string) => {
    if (!profile.publicDomain) {
      setPresignKey(key);
      return;
    }
    await writeText(publicUrl(profile.publicDomain, key));
    toast("链接已复制", "success");
  };

  const copyLinks = async (keys: string[]) => {
    if (!profile.publicDomain) return toast("请先在配置中设置公开访问域名", "info");
    const links = keys.filter((k) => !k.endsWith("/")).map((k) => publicUrl(profile.publicDomain, k));
    await writeText(links.join("\n"));
    toast(`已复制 ${links.length} 个链接`, "success");
  };

  const cleanup = async () => {
    const ok = await dialog.confirm({
      title: "清理未完成的上传",
      message: "将中止该 Bucket 中所有未完成的分片上传并释放其占用的空间。正在进行的上传也会被中断，确定继续？",
      okText: "清理",
    });
    if (!ok) return;
    setBusy("正在清理…");
    try {
      const n = await api.abortIncomplete(profile.id, activeBucket);
      toast(n ? `已清理 ${n} 个未完成上传` : "没有未完成的上传", "success");
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const selKeys = [...selected];

  const handleSelectBucket = (b: string) => {
    setIsBucketOpen(false);
    setBucketSearch("");
    if (b !== activeBucket) {
      onSelectBucket(b);
    }
  };

  return (
    <section className="browser">
      <header className="toolbar">
        <div className="crumbs">
          {isSidebarCollapsed && onToggleSidebar && (
            <button
              type="button"
              className="icon-btn sm sidebar-expand-btn"
              onClick={onToggleSidebar}
              title="展开侧边栏 (Cmd+B)"
              aria-label="展开侧边栏"
              style={{ marginRight: 6, flexShrink: 0 }}
            >
              <Icon name="sidebar" size={14} />
            </button>
          )}

          {/* 方案一：顶部面包屑 Bucket 下拉选择 */}
          <div className="bucket-dropdown-anchor" ref={bucketMenuRef}>
            <button
              type="button"
              className={`crumb bucket-crumb ${prefix === "" ? "current" : ""} ${isBucketOpen ? "open" : ""}`}
              onClick={() => {
                if (allBuckets.length > 1) {
                  setIsBucketOpen(!isBucketOpen);
                } else {
                  setPrefix("");
                }
              }}
              title={allBuckets.length > 1 ? "点击快速切换存储桶" : "回到存储桶根目录"}
            >
              <Icon name="database" size={14} className="bucket-crumb-icon" />
              <span className="bucket-crumb-text">{activeBucket || "选择存储桶"}</span>
              {allBuckets.length > 1 && (
                <Icon
                  name="chevronDown"
                  size={12}
                  className={`bucket-crumb-arrow ${isBucketOpen ? "flip" : ""}`}
                />
              )}
            </button>

            {/* 存储桶下拉浮层 */}
            {isBucketOpen && (
              <div className="bucket-menu" onMouseDown={(e) => e.stopPropagation()}>
                <div className="bucket-menu-search">
                  <Icon name="search" size={13} />
                  <input
                    autoFocus
                    placeholder="搜索存储桶..."
                    value={bucketSearch}
                    onChange={(e) => setBucketSearch(e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="icon-btn sm"
                    title="刷新存储桶列表"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRefreshBuckets();
                    }}
                  >
                    <Icon name="refresh" size={12} className={fetchingBuckets ? "spin" : ""} />
                  </button>
                </div>
                <div className="bucket-menu-list">
                  {fetchingBuckets && (
                    <div className="bucket-menu-loading">
                      <span className="spinner" /> 正在获取存储桶列表…
                    </div>
                  )}
                  {!fetchingBuckets &&
                    filteredBuckets.map((b) => (
                      <div
                        key={b}
                        className={`bucket-menu-item ${b === activeBucket ? "active" : ""}`}
                        onClick={() => handleSelectBucket(b)}
                      >
                        <Icon name="database" size={13} />
                        <span className="bucket-menu-item-name">{b}</span>
                        {b === activeBucket && <Icon name="check" size={13} className="ok-text" />}
                      </div>
                    ))}
                  {!fetchingBuckets && filteredBuckets.length === 0 && (
                    <div className="bucket-menu-empty">
                      {bucketSearch ? "未找到匹配的存储桶" : "未获取到其他存储桶"}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {selected.size > 0 ? (
          <div className="toolbar-batch-actions">
            <div className="batch-badge">
              已选择 <b>{selected.size}</b> 项
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => download(selKeys)}
              title="批量下载选中文件"
            >
              <Icon name="download" size={14} /> <span className="btn-text">下载</span>
            </button>
            {profile.publicDomain && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => copyLinks(selKeys)}
                title="批量复制公开链接"
              >
                <Icon name="link" size={14} /> <span className="btn-text">复制链接</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-ghost danger-text"
              onClick={() => remove(selKeys)}
              title="批量删除选中项"
            >
              <Icon name="trash" size={14} /> <span className="btn-text">删除</span>
            </button>
            <div className="toolbar-sep" />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSelected(new Set())}
              title="取消全部多选"
            >
              <Icon name="x" size={13} /> <span className="btn-text">取消选择</span>
            </button>
          </div>
        ) : (
          <div className="toolbar-actions">
            <div className="search">
              <Icon name="search" size={14} />
              <input
                id="search-input"
                placeholder="搜索当前目录"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {searchInput && (
                <button
                  type="button"
                  className="icon-btn sm"
                  title="清空"
                  style={{ width: 20, height: 20, padding: 0, border: "none", background: "transparent", color: "var(--text-dim)" }}
                  onClick={() => setSearchInput("")}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <button className="icon-btn" title="强制刷新 (绕过缓存)" onClick={() => load(true)} id="btn-refresh">
              <Icon name="refresh" className={loading ? "spin" : ""} />
            </button>
            <button className="icon-btn" title="清理未完成的分片上传" onClick={cleanup} id="btn-cleanup">
              <Icon name="broom" />
            </button>
            <button
              className="icon-btn"
              title="操作历史记录（查看删除/改名等操作，方便纠错）"
              onClick={() => setIsHistoryOpen(true)}
              id="btn-operation-history"
            >
              <Icon name="history" size={15} />
            </button>
            <button className="btn btn-ghost" onClick={newFolder} id="btn-new-folder" title="新建文件夹">
              <Icon name="folderPlus" size={14} />
              <span className="btn-text">新建文件夹</span>
            </button>
            <button className="btn btn-ghost" onClick={() => pickFiles(true)} id="btn-upload-folder" title="上传文件夹">
              <Icon name="folderUp" size={14} />
              <span className="btn-text">上传文件夹</span>
            </button>
            <button className="btn btn-primary" onClick={() => pickFiles(false)} id="btn-upload-files" title="上传文件">
              <Icon name="upload" size={14} />
              <span className="btn-text">上传文件</span>
            </button>
          </div>
        )}
      </header>

      <div className="table-wrap">
        <div className="thead">
          <label className="cell-check">
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
          </label>
          <button className="th th-name" onClick={() => setSortKey("name")}>
            名称 {sort.key === "name" && <Icon name="chevronDown" size={12} className={sort.asc ? "" : "flip"} />}
          </button>
          <button className="th th-size" onClick={() => setSortKey("size")}>
            大小 {sort.key === "size" && <Icon name="chevronDown" size={12} className={sort.asc ? "" : "flip"} />}
          </button>
          <button className="th th-time" onClick={() => setSortKey("time")}>
            修改时间 {sort.key === "time" && <Icon name="chevronDown" size={12} className={sort.asc ? "" : "flip"} />}
          </button>
          <div className="th th-actions" />
        </div>

        <div
          className="tbody"
          ref={tbodyRef}
          onScroll={handleScroll}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu(null);
          }}
        >
          {prefix && !search && (
            <div className="row row-up" onDoubleClick={() => setPrefix(crumbs.length > 1 ? crumbs[crumbs.length - 2].prefix : "")}>
              <span className="cell-check" />
              <div
                className="cell-name"
                onClick={() => setPrefix(crumbs.length > 1 ? crumbs[crumbs.length - 2].prefix : "")}
              >
                <span className="ficon k-folder">
                  <Icon name="folder" size={16} />
                </span>
                <span className="fname">..</span>
              </div>
            </div>
          )}

          {totalRows > 0 && (
            <div className="vlist-wrap" style={{ height: totalVirtualHeight, position: "relative" }}>
              {visibleRows.map(({ item: r, top }) => {
                const kind = fileKind(r.key);
                return (
                  <div
                    key={r.key}
                    className={`row ${selected.has(r.key) ? "selected" : ""} ${contextMenu?.row.key === r.key ? "context-active" : ""}`}
                    style={{ position: "absolute", top, left: 0, right: 0, height: ROW_HEIGHT }}
                    onDoubleClick={() => r.isDir && setPrefix(r.key)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      // 1. 彻底清除文字选中高亮（去除浅蓝色文字选取块）
                      window.getSelection()?.removeAllRanges();
                      // 2. 如果右键的项不在已有多选集合中，清空旧多选项，但不把当前项加入 selected（防止顶出顶部控制条引起列表向下顿跳）
                      if (!selected.has(r.key) && selected.size > 0) {
                        setSelected(new Set());
                      }
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        row: r,
                      });
                    }}
                  >
                    <label className="cell-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} />
                    </label>
                    <div className="cell-name" onClick={() => (r.isDir ? setPrefix(r.key) : toggle(r.key))}>
                      <span className={`ficon k-${kind}`}>
                        <Icon name={kind} size={16} />
                      </span>
                      <span className="fname" title={r.key}>
                        {r.name}
                      </span>
                    </div>
                    <div className="cell-size">{r.isDir ? "—" : formatBytes(r.size)}</div>
                    <div className="cell-time">{r.isDir ? "—" : formatTime(r.lastModified)}</div>
                    <div className="cell-actions">
                      {!r.isDir && (
                        <>
                          <button className="icon-btn sm" title="复制链接" onClick={() => copyLink(r.key)}>
                            <Icon name="link" size={14} />
                          </button>
                          <button className="icon-btn sm" title="生成签名链接" onClick={() => setPresignKey(r.key)}>
                            <Icon name="key" size={14} />
                          </button>
                          <button className="icon-btn sm" title="下载" onClick={() => download([r.key])}>
                            <Icon name="download" size={14} />
                          </button>
                        </>
                      )}
                      <button className="icon-btn sm" title="重命名" onClick={() => rename(r)}>
                        <Icon name="edit" size={14} />
                      </button>
                      <button className="icon-btn sm danger-text" title="删除" onClick={() => remove([r.key])}>
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* 触底加载状态或提示 */}
          {nextToken && !loading && (
            <div className="list-more-bar">
              {loadingMore || loadingAll ? (
                <span className="status-loading">
                  <span className="spinner" /> 正在加载后续条目…
                </span>
              ) : (
                <div className="list-more-hint">
                  <span>已载入当前批次，向下滚动自动加载，或</span>
                  <button type="button" className="btn-link" onClick={loadAll}>一键全部载入</button>
                </div>
              )}
            </div>
          )}

          {!loading && !error && rows.length === 0 && (
            <div className="empty">
              <div className="empty-art">
                <Icon name="upload" size={34} />
              </div>
              <h2>{search ? "没有匹配的文件" : "这里还是空的"}</h2>
              <p>{search ? "换个关键词试试" : "将文件或文件夹拖拽到窗口任意位置即可上传"}</p>
            </div>
          )}
          {error && (
            <div className="empty error">
              <div className="empty-art">
                <Icon name="alert" size={34} />
              </div>
              <h2>加载失败</h2>
              <p className="err-text">{error}</p>
              <button className="btn btn-ghost" onClick={() => load(true)}>
                <Icon name="refresh" /> 重试
              </button>
            </div>
          )}
          {loading && rows.length === 0 && (
            <div className="skeletons">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="skeleton" style={{ animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          )}
        </div>

        {scrollTop > 260 && (
          <button
            type="button"
            className="scroll-to-top-btn"
            title="返回顶部"
            onClick={() => tbodyRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          >
            <Icon name="arrowUp" size={16} />
          </button>
        )}
      </div>

      <footer className="statusbar">
        <div className="statusbar-left statusbar-path">
          <button
            type="button"
            className={`status-crumb ${prefix === "" ? "current" : ""}`}
            onClick={() => setPrefix("")}
            title="存储桶根目录"
          >
            <Icon name="database" size={12} />
            <span>根目录</span>
          </button>
          {crumbs.map((c, i) => (
            <span key={c.prefix} className="status-crumb-item">
              <Icon name="chevronRight" size={11} className="status-crumb-sep" />
              <button
                type="button"
                className={`status-crumb ${i === crumbs.length - 1 ? "current" : ""}`}
                onClick={() => setPrefix(c.prefix)}
                title={`跳转到 ${c.name}`}
              >
                <Icon name="folder" size={12} />
                <span>{c.name}</span>
              </button>
            </span>
          ))}
        </div>

        <div className="statusbar-right">
          {(loading || loadingMore || loadingAll) && (
            <span className="status-loading">
              <span className="spinner" /> {loadingAll ? "正在连续拉取所有对象…" : loadingMore ? "正在加载后续条目…" : "加载中…"}
            </span>
          )}
          {busy && (
            <span className="status-loading">
              <span className="spinner" /> {busy}
            </span>
          )}
          <span className="statusbar-counts">
            {nextToken ? "已载入 " : "共 "}
            {folders.length} 个文件夹 · {files.length} 个文件 · {formatBytes(totalSize)}
            {nextToken && <span style={{ opacity: 0.65 }}>（未全部载入）</span>}
          </span>
          {nextToken && !loading && (
            loadingAll ? (
              <button type="button" className="btn btn-xs btn-ghost danger-text" onClick={stopLoadAll}>
                停止载入
              </button>
            ) : (
              <button type="button" className="btn btn-xs btn-ghost" onClick={loadAll} title="连续批量拉取所有剩余对象">
                全部载入
              </button>
            )
          )}
        </div>
      </footer>

      {presignKey && (
        <PresignModal
          profile={profile}
          bucket={activeBucket}
          objectKey={presignKey}
          onClose={() => setPresignKey(null)}
        />
      )}

      {contextMenu && (() => {
        const isMultiSelected = selected.size > 1 && selected.has(contextMenu.row.key);
        const selList = Array.from(selected);

        // 精准定位：挂载到 body 上，紧跟鼠标点击焦点（避免因父级 backdrop-filter 偏移）
        const menuWidth = 185;
        const menuHeight = isMultiSelected ? 175 : 205;
        const left = contextMenu.x + menuWidth > window.innerWidth
          ? Math.max(10, contextMenu.x - menuWidth)
          : contextMenu.x + 2;
        const top = contextMenu.y + menuHeight > window.innerHeight
          ? Math.max(10, contextMenu.y - menuHeight)
          : contextMenu.y + 2;

        return createPortal(
          <div
            className="row-context-menu"
            style={{
              position: "fixed",
              left,
              top,
              zIndex: 9999,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {isMultiSelected ? (
              // ================= 多选状态下的批量上下文菜单 =================
              <>
                <div className="context-menu-header">已选择 {selected.size} 项</div>
                <button
                  className="context-menu-item"
                  onClick={() => {
                    download(selList);
                    setContextMenu(null);
                  }}
                >
                  <Icon name="download" size={14} /> 批量下载 ({selected.size} 项)
                </button>
                {profile.publicDomain && (
                  <button
                    className="context-menu-item"
                    onClick={() => {
                      copyLinks(selList);
                      setContextMenu(null);
                    }}
                  >
                    <Icon name="link" size={14} /> 批量复制链接 ({selected.size} 项)
                  </button>
                )}
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    remove(selList);
                    setContextMenu(null);
                  }}
                >
                  <Icon name="trash" size={14} /> 批量删除 ({selected.size} 项)
                </button>
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    setSelected(new Set());
                    setContextMenu(null);
                  }}
                >
                  <Icon name="x" size={14} /> 取消选择
                </button>
              </>
            ) : (
              // ================= 单项状态下的常规上下文菜单 =================
              <>
                {contextMenu.row.isDir ? (
                  <button
                    className="context-menu-item"
                    onClick={() => {
                      setPrefix(contextMenu.row.key);
                      setContextMenu(null);
                    }}
                  >
                    <Icon name="folder" size={14} /> 打开文件夹
                  </button>
                ) : (
                  <>
                    <button
                      className="context-menu-item"
                      onClick={() => {
                        copyLink(contextMenu.row.key);
                        setContextMenu(null);
                      }}
                    >
                      <Icon name="link" size={14} /> 复制访问链接
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => {
                        setPresignKey(contextMenu.row.key);
                        setContextMenu(null);
                      }}
                    >
                      <Icon name="key" size={14} /> 生成临时签名链接
                    </button>
                    <button
                      className="context-menu-item"
                      onClick={() => {
                        download([contextMenu.row.key]);
                        setContextMenu(null);
                      }}
                    >
                      <Icon name="download" size={14} /> 下载文件
                    </button>
                  </>
                )}
                <div className="context-menu-divider" />
                <button
                  className="context-menu-item"
                  onClick={() => {
                    rename(contextMenu.row);
                    setContextMenu(null);
                  }}
                >
                  <Icon name="edit" size={14} /> 重命名
                </button>
                <button
                  className="context-menu-item danger"
                  onClick={() => {
                    remove([contextMenu.row.key]);
                    setContextMenu(null);
                  }}
                >
                  <Icon name="trash" size={14} /> 删除
                </button>
              </>
            )}
          </div>,
          document.body
        );
      })()}

      {isHistoryOpen && <OperationHistoryModal onClose={() => setIsHistoryOpen(false)} />}
    </section>
  );
}

function PresignModal({
  profile,
  bucket,
  objectKey,
  onClose,
}: {
  profile: Profile;
  bucket: string;
  objectKey: string;
  onClose: () => void;
}) {
  const [expires, setExpires] = useState(3600 * 24);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setLoading(true);
    api
      .presignUrl(profile.id, objectKey, expires, bucket)
      .then(setUrl)
      .catch((e) => toast(errMsg(e), "error"))
      .finally(() => setLoading(false));
  }, [expires, objectKey, profile.id, bucket, toast]);

  const copy = async () => {
    await writeText(url);
    toast("签名链接已复制", "success");
    onClose();
  };

  const opts: [number, string][] = [
    [3600, "1 小时"],
    [3600 * 6, "6 小时"],
    [3600 * 24, "1 天"],
    [3600 * 24 * 3, "3 天"],
    [3600 * 24 * 7, "7 天"],
  ];

  return (
    <Modal
      title="签名链接"
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={copy} disabled={!url || loading}>
            <Icon name="link" /> 复制链接
          </button>
        </>
      }
    >
      <p className="dialog-msg">
        为 <b>{baseName(objectKey)}</b> 生成临时访问链接（私有 Bucket 也可访问）
      </p>
      <div className="seg">
        {opts.map(([v, l]) => (
          <button key={v} className={`seg-item ${v === expires ? "active" : ""}`} onClick={() => setExpires(v)}>
            {l}
          </button>
        ))}
      </div>
      <textarea className="input mono url-box" readOnly value={loading ? "生成中…" : url} rows={4} />
    </Modal>
  );
}
