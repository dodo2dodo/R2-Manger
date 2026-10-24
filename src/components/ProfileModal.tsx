import { useState } from "react";
import { api, errMsg, type Profile } from "../api";
import { Modal, useDialog, useToast } from "../ui";
import { Icon } from "../icons";

const empty: Profile = { id: "", name: "", accountId: "", accessKeyId: "", bucket: "", publicDomain: "", endpoint: "" };

export function ProfileModal({
  profile,
  onClose,
  onSaved,
  onDeleted,
}: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: (p: Profile) => void;
  onDeleted: (id: string) => void;
}) {
  const isEdit = !!profile?.id;
  const [f, setF] = useState<Profile>(profile ?? empty);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"" | "test" | "save" | "fetch">("");
  const [advanced, setAdvanced] = useState(!!profile?.endpoint);
  const [bucketOptions, setBucketOptions] = useState<string[]>([]);
  const toast = useToast();
  const dialog = useDialog();

  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const validate = () => {
    if (!f.accountId.trim() && !f.endpoint.trim()) return "请填写 Account ID 或 S3 Endpoint";
    if (!f.accessKeyId.trim()) return "请填写 Access Key ID";
    if (!isEdit && !secret.trim()) return "请填写 Secret Access Key";
    return "";
  };

  // 获取存储桶列表
  const fetchBuckets = async () => {
    const err = validate();
    if (err) return toast(err, "error");
    setBusy("fetch");
    try {
      const buckets = await api.listBuckets(f, secret || null);
      if (buckets.length > 0) {
        setBucketOptions(buckets);
        if (!f.bucket || !buckets.includes(f.bucket)) {
          setF((prev) => ({ ...prev, bucket: buckets[0] }));
        }
        toast(`成功获取到 ${buckets.length} 个存储桶`, "success");
      } else {
        toast("连接成功，但当前账户下暂未创建任何存储桶", "info");
      }
    } catch (e) {
      toast(`获取存储桶失败: ${errMsg(e)} (若该 Token 仅授权了特定桶，请手动输入桶名)`, "error");
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    const err = validate();
    if (err) return toast(err, "error");
    setBusy("test");
    try {
      const buckets = await api.testProfile(f, secret || null);
      if (buckets.length > 0) {
        setBucketOptions(buckets);
        if (!f.bucket) {
          setF((prev) => ({ ...prev, bucket: buckets[0] }));
        }
      }
      toast(f.bucket ? `连接成功！已验证存储桶 [${f.bucket}]` : `连接成功！找到 ${buckets.length} 个存储桶`, "success");
    } catch (e) {
      toast(`连接失败：${errMsg(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  const submit = async () => {
    const err = validate();
    if (err) return toast(err, "error");

    let finalBucket = f.bucket.trim();
    setBusy("save");

    // 如果用户没有填 Bucket，尝试自动获取第一个
    if (!finalBucket) {
      try {
        const buckets = await api.listBuckets(f, secret || null);
        if (buckets.length > 0) {
          finalBucket = buckets[0];
          setF((prev) => ({ ...prev, bucket: buckets[0] }));
        } else {
          setBusy("");
          return toast("当前账号下无可用存储桶，请在 Cloudflare 创建或手动输入", "error");
        }
      } catch {
        setBusy("");
        return toast("无法自动列出存储桶，若该 Token 仅授权了单个桶，请直接在 Bucket 框输入桶名", "error");
      }
    }

    try {
      const p = await api.saveProfile(
        {
          ...f,
          bucket: finalBucket,
          name: f.name.trim() || finalBucket,
        },
        secret || null
      );
      toast("配置已保存", "success");
      onSaved(p);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy("");
    }
  };

  const remove = async () => {
    const ok = await dialog.confirm({
      title: "删除配置",
      message: `确定删除配置「${f.name}」吗？R2 中的文件不会受影响。`,
      danger: true,
      okText: "删除",
    });
    if (!ok) return;
    await api.deleteProfile(f.id);
    onDeleted(f.id);
  };

  return (
    <Modal
      title={isEdit ? "编辑配置" : "添加 R2 配置"}
      onClose={onClose}
      width={540}
      footer={
        <>
          {isEdit && (
            <button className="btn btn-ghost danger-text" onClick={remove} style={{ marginRight: "auto" }}>
              <Icon name="trash" /> 删除
            </button>
          )}
          <button className="btn btn-ghost" onClick={test} disabled={!!busy}>
            {busy === "test" ? <span className="spinner" /> : <Icon name="link" />} 测试连接
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!!busy}>
            {busy === "save" ? <span className="spinner" /> : <Icon name="check" />} 保存
          </button>
        </>
      }
    >
      <div className="form">
        <label className="field">
          <span>名称</span>
          <input className="input" value={f.name} onChange={set("name")} placeholder="如：生产环境（留空则自动使用存储桶名）" />
        </label>

        <label className="field">
          <span>
            Account ID / Endpoint
            <em>（可直接粘贴 S3 Endpoint，自动提取）</em>
          </span>
          <input
            className="input mono"
            value={f.accountId}
            onChange={(e) => {
              const val = e.target.value.trim();
              const match = val.match(/(?:https?:\/\/)?([a-f0-9]{32})\.r2\.cloudflarestorage\.com/i);
              if (match) {
                setF({ ...f, accountId: match[1] });
              } else {
                setF({ ...f, accountId: val });
              }
            }}
            placeholder="填写 32位 Account ID 或直接粘贴完整 S3 Endpoint"
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Access Key ID</span>
            <input className="input mono" value={f.accessKeyId} onChange={set("accessKeyId")} autoComplete="off" />
          </label>
          <label className="field">
            <span>Secret Access Key</span>
            <input
              className="input mono"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={isEdit ? "留空则保持不变" : ""}
              autoComplete="new-password"
            />
          </label>
        </div>

        {/* Bucket 存储桶输入 / 下拉选择 */}
        <div className="field">
          <span>
            Bucket 存储桶 <em>可选（不填可自动获取或自动使用第一个）</em>
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            {bucketOptions.length > 0 ? (
              <select
                className="select mono"
                value={f.bucket}
                onChange={(e) => setF({ ...f, bucket: e.target.value })}
              >
                <option value="">-- 请选择存储桶 --</option>
                {bucketOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input mono"
                value={f.bucket}
                onChange={set("bucket")}
                placeholder="可留空，或点击右侧自动拉取，或手动输入桶名"
              />
            )}
            <button
              type="button"
              className="btn btn-ghost"
              onClick={fetchBuckets}
              disabled={!!busy}
              style={{ whiteSpace: "nowrap" }}
              title="自动从 Cloudflare 拉取当前账户下的所有 Bucket 列表"
            >
              {busy === "fetch" ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
              获取存储桶
            </button>
          </div>
        </div>

        <label className="field">
          <span>
            公开访问域名 <em>可选</em>
          </span>
          <input
            className="input mono"
            value={f.publicDomain}
            onChange={set("publicDomain")}
            placeholder="https://cdn.example.com 或 r2.dev 公共地址"
          />
        </label>

        <button className="link-btn" onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} /> 高级选项
        </button>
        {advanced && (
          <label className="field">
            <span>
              自定义 Endpoint <em>可选</em>
            </span>
            <input
              className="input mono"
              value={f.endpoint}
              onChange={set("endpoint")}
              placeholder="https://<account>.eu.r2.cloudflarestorage.com"
            />
          </label>
        )}

        <p className="hint">
          <Icon name="key" size={13} /> Secret Key 保存在系统钥匙串中，不会以明文写入磁盘。
        </p>
      </div>
    </Modal>
  );
}
