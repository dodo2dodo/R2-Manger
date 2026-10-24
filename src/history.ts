import { load, save } from "./utils";

export type OperationType = "delete" | "rename" | "create_folder";

export interface OperationRecord {
  id: string;
  type: OperationType;
  timestamp: number;
  bucket: string;
  profileId: string;
  summary: string;
  details: {
    oldPath?: string;
    newPath?: string;
    paths?: string[];
    name?: string;
  };
}

const HISTORY_KEY = "r2_operation_history";
const MAX_HISTORY = 500;

export function getOperationHistory(): OperationRecord[] {
  return load<OperationRecord[]>(HISTORY_KEY, []);
}

export function addOperationRecord(
  record: Omit<OperationRecord, "id" | "timestamp">
): OperationRecord {
  const current = getOperationHistory();
  const newRecord: OperationRecord = {
    ...record,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
  };
  const updated = [newRecord, ...current].slice(0, MAX_HISTORY);
  save(HISTORY_KEY, updated);
  window.dispatchEvent(new CustomEvent("r2_operation_history_changed"));
  return newRecord;
}

export function clearOperationHistory(): void {
  save(HISTORY_KEY, []);
  window.dispatchEvent(new CustomEvent("r2_operation_history_changed"));
}

export function removeOperationRecord(id: string): void {
  const current = getOperationHistory();
  const updated = current.filter((r) => r.id !== id);
  save(HISTORY_KEY, updated);
  window.dispatchEvent(new CustomEvent("r2_operation_history_changed"));
}
