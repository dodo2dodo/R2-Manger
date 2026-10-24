import { invoke } from "@tauri-apps/api/core";

export interface Profile {
  id: string;
  name: string;
  accountId: string;
  accessKeyId: string;
  bucket: string;
  publicDomain: string;
  endpoint: string;
}

export interface FileEntry {
  key: string;
  size: number;
  lastModified: number;
}

export interface ListResult {
  folders: string[];
  files: FileEntry[];
  nextToken: string | null;
}

export interface UploadItem {
  localPath: string;
  key: string;
  size: number;
}

export interface TaskInfo extends UploadItem {
  id: string;
}

export type UploadStatus = "queued" | "uploading" | "done" | "error" | "canceled" | "skipped";

export interface ProgressEvent {
  id: string;
  status: UploadStatus;
  uploaded: number;
  total: number;
  key: string;
  error: string | null;
}

export type Conflict = "overwrite" | "skip" | "rename";

export const api = {
  listProfiles: () => invoke<Profile[]>("list_profiles"),
  saveProfile: (profile: Profile, secret: string | null) =>
    invoke<Profile>("save_profile", { profile, secret }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  testProfile: (profile: Profile, secret: string | null) =>
    invoke<string[]>("test_profile", { profile, secret }),
  listBuckets: (profile: Profile, secret: string | null) =>
    invoke<string[]>("list_buckets", { profile, secret }),
  getProfileBuckets: (profileId: string) =>
    invoke<string[]>("get_profile_buckets", { profileId }),
  switchProfileBucket: (profileId: string, bucket: string) =>
    invoke<Profile>("switch_profile_bucket", { profileId, bucket }),
  listObjects: (profileId: string, prefix: string, token: string | null, bucket?: string) =>
    invoke<ListResult>("list_objects", { profileId, prefix, token, bucket: bucket || null }),
  deleteObjects: (profileId: string, keys: string[], bucket?: string) =>
    invoke<number>("delete_objects", { profileId, keys, bucket: bucket || null }),
  renameObject: (profileId: string, from: string, to: string, bucket?: string) =>
    invoke<void>("rename_object", { profileId, from, to, bucket: bucket || null }),
  createFolder: (profileId: string, key: string, bucket?: string) =>
    invoke<void>("create_folder", { profileId, key, bucket: bucket || null }),
  downloadObject: (profileId: string, key: string, dest: string, bucket?: string) =>
    invoke<void>("download_object", { profileId, key, dest, bucket: bucket || null }),
  presignUrl: (profileId: string, key: string, expires: number, bucket?: string) =>
    invoke<string>("presign_url", { profileId, key, expires, bucket: bucket || null }),
  abortIncomplete: (profileId: string, bucket?: string) =>
    invoke<number>("abort_incomplete_uploads", { profileId, bucket: bucket || null }),
  expandPaths: (paths: string[], prefix: string) => invoke<UploadItem[]>("expand_paths", { paths, prefix }),
  startUploads: (
    profileId: string,
    items: UploadItem[],
    concurrency: number,
    conflict: Conflict,
    bucket?: string
  ) =>
    invoke<TaskInfo[]>("start_uploads", {
      profileId,
      items,
      concurrency,
      conflict,
      bucket: bucket || null,
    }),
  cancelUpload: (id: string) => invoke<void>("cancel_upload", { id }),
  cancelAllUploads: () => invoke<void>("cancel_all_uploads"),
  openExternalUrl: (url: string) => invoke<void>("open_external_url", { url }),
};

export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
