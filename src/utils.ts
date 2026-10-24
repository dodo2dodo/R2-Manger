export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

export function formatTime(ms: number): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function baseName(key: string): string {
  const k = key.endsWith("/") ? key.slice(0, -1) : key;
  return k.slice(k.lastIndexOf("/") + 1);
}

export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function publicUrl(domain: string, key: string): string {
  let d = domain.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(d)) d = `https://${d}`;
  return `${d}/${encodeKey(key)}`;
}

export type FileKind = "folder" | "image" | "video" | "audio" | "archive" | "app" | "code" | "doc" | "file";

const KINDS: Record<string, FileKind> = {};
const reg = (kind: FileKind, exts: string) => exts.split(" ").forEach((e) => (KINDS[e] = kind));
reg("image", "png jpg jpeg gif webp svg bmp ico avif heic tiff");
reg("video", "mp4 mov avi mkv webm flv m4v wmv");
reg("audio", "mp3 wav flac aac ogg m4a wma opus");
reg("archive", "zip rar 7z tar gz tgz bz2 xz zst");
reg("app", "dmg exe msi pkg apk ipa deb rpm appimage blockmap");
reg("code", "yaml yml json xml toml ini js ts css html sh py rs go java plist");
reg("doc", "pdf doc docx xls xlsx ppt pptx txt md csv rtf");

export function fileKind(key: string): FileKind {
  if (key.endsWith("/")) return "folder";
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
  return KINDS[ext] ?? "file";
}

export function load<T>(k: string, def: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : def;
  } catch {
    return def;
  }
}

export function save(k: string, v: unknown) {
  localStorage.setItem(k, JSON.stringify(v));
}
