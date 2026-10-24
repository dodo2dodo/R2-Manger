import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons";

/* ---------------- Modal ---------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------- Toast ---------------- */

type ToastType = "success" | "error" | "info";
interface ToastItem {
  id: number;
  type: ToastType;
  text: string;
}

const ToastCtx = createContext<(text: string, type?: ToastType) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((text: string, type: ToastType = "info") => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-4), { id, type, text }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), type === "error" ? 6000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            <Icon name={t.type === "success" ? "check" : t.type === "error" ? "alert" : "cloud"} />
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- Dialogs (prompt / confirm) ---------------- */

interface PromptState {
  kind: "prompt" | "confirm";
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  danger?: boolean;
  okText?: string;
  resolve: (v: string | null) => void;
}

const DialogCtx = createContext<{
  prompt: (o: { title: string; value?: string; placeholder?: string; message?: string }) => Promise<string | null>;
  confirm: (o: { title: string; message: string; danger?: boolean; okText?: string }) => Promise<boolean>;
}>(null as never);
export const useDialog = () => useContext(DialogCtx);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<PromptState | null>(null);
  const [val, setVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const prompt = useCallback(
    (o: { title: string; value?: string; placeholder?: string; message?: string }) =>
      new Promise<string | null>((resolve) => {
        setVal(o.value ?? "");
        setSt({ kind: "prompt", ...o, resolve });
      }),
    [],
  );
  const confirm = useCallback(
    (o: { title: string; message: string; danger?: boolean; okText?: string }) =>
      new Promise<boolean>((resolve) => setSt({ kind: "confirm", ...o, resolve: (v) => resolve(v !== null) })),
    [],
  );

  useEffect(() => {
    if (st?.kind === "prompt") {
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = el.value.lastIndexOf(".");
        el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
      }, 30);
    }
  }, [st]);

  const close = (v: string | null) => {
    st?.resolve(v);
    setSt(null);
  };

  return (
    <DialogCtx.Provider value={{ prompt, confirm }}>
      {children}
      {st && (
        <Modal
          title={st.title}
          onClose={() => close(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => close(null)}>
                取消
              </button>
              <button
                className={`btn ${st.danger ? "btn-danger" : "btn-primary"}`}
                onClick={() => (st.kind === "prompt" ? val.trim() && close(val.trim()) : close("ok"))}
              >
                {st.okText ?? "确定"}
              </button>
            </>
          }
        >
          {st.message && <p className="dialog-msg">{st.message}</p>}
          {st.kind === "prompt" && (
            <input
              ref={inputRef}
              className="input"
              value={val}
              placeholder={st.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && val.trim() && close(val.trim())}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </Modal>
      )}
    </DialogCtx.Provider>
  );
}
