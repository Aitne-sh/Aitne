"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { EditableConfigKey } from "@aitne/shared";
import type { ConfigValue } from "@/lib/hooks/use-save-config";

/** Deep-equal for ConfigValue (handles string[] by value). */
function valuesEqual(a: ConfigValue, b: ConfigValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return false;
}

interface DirtyFieldsContextValue {
  /** Map of keys with uncommitted draft values. */
  dirtyFields: Map<EditableConfigKey, ConfigValue>;
  /** Register (or update) a dirty value.
   *  If `serverValue` is provided and matches `value`, the key is removed
   *  from the dirty set instead (edit-back / toggle-back detection). */
  setDirty: (key: EditableConfigKey, value: ConfigValue, serverValue?: ConfigValue) => void;
  /** Remove a single key from the dirty set. */
  clearDirty: (key: EditableConfigKey) => void;
  /** Remove multiple keys from the dirty set. */
  clearDirtyKeys: (keys: EditableConfigKey[]) => void;
  /** Discard all uncommitted changes. */
  discardAll: () => void;
  /** Monotonically increasing counter — bumped on every discard so field
   *  components can reset their local drafts via a key or effect. */
  discardGeneration: number;
  /** True when at least one field has an uncommitted change. */
  isDirty: boolean;
  /** Number of uncommitted fields. */
  dirtyCount: number;
}

const DirtyFieldsContext = createContext<DirtyFieldsContextValue | null>(null);

/**
 * Provides dirty-field tracking for batched settings save.
 * Mount once in the settings layout — consumed by `useDirtyFields()`.
 */
export function DirtyFieldsProvider({ children }: { children: ReactNode }) {
  const [dirtyFields, setDirtyFields] = useState<
    Map<EditableConfigKey, ConfigValue>
  >(() => new Map());
  const [discardGeneration, setDiscardGeneration] = useState(0);

  const setDirty = useCallback(
    (key: EditableConfigKey, value: ConfigValue, serverValue?: ConfigValue) => {
      setDirtyFields((prev) => {
        // If the new value matches the server value, remove from dirty
        // (edit-back / toggle-back detection).
        if (serverValue !== undefined && valuesEqual(value, serverValue)) {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        }
        const next = new Map(prev);
        next.set(key, value);
        return next;
      });
    },
    [],
  );

  const clearDirty = useCallback((key: EditableConfigKey) => {
    setDirtyFields((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const clearDirtyKeys = useCallback((keys: EditableConfigKey[]) => {
    if (keys.length === 0) return;
    setDirtyFields((prev) => {
      if (!keys.some((k) => prev.has(k))) return prev;
      const next = new Map(prev);
      for (const key of keys) next.delete(key);
      return next;
    });
  }, []);

  const discardAll = useCallback(() => {
    setDirtyFields(new Map());
    setDiscardGeneration((g) => g + 1);
  }, []);

  const isDirty = dirtyFields.size > 0;
  const dirtyCount = dirtyFields.size;

  const value = useMemo<DirtyFieldsContextValue>(
    () => ({
      dirtyFields,
      setDirty,
      clearDirty,
      clearDirtyKeys,
      discardAll,
      discardGeneration,
      isDirty,
      dirtyCount,
    }),
    [dirtyFields, setDirty, clearDirty, clearDirtyKeys, discardAll, discardGeneration, isDirty, dirtyCount],
  );

  return createElement(DirtyFieldsContext.Provider, { value }, children);
}

/**
 * Returns the current discard generation counter, or 0 if outside a
 * DirtyFieldsProvider.  Field components use this to reset local editing
 * state when the user clicks Discard in the save bar.
 */
export function useDiscardGeneration(): number {
  const ctx = useContext(DirtyFieldsContext);
  return ctx?.discardGeneration ?? 0;
}

/**
 * Access the dirty-fields context.  Must be called inside `DirtyFieldsProvider`.
 *
 * Returns:
 * - `deferSaveFor(config)` — returns a `SaveFieldFn` with toggle-back detection
 * - `dv(key, serverValue)` — returns dirty value if it exists, else serverValue
 * - all raw context fields for the save bar
 */
export function useDirtyFields() {
  const ctx = useContext(DirtyFieldsContext);
  if (!ctx) {
    throw new Error("useDirtyFields must be used inside DirtyFieldsProvider");
  }

  const { setDirty, dirtyFields } = ctx;

  /**
   * Returns a `SaveFieldFn` that compares against `serverConfig` to detect
   * toggle-back (editing a value back to the server value removes the dirty
   * entry instead of keeping a spurious one).
   *
   * The returned function is a new closure per call. Pages call this after
   * the `if (!config)` guard, so it cannot be wrapped in `useMemo` without
   * violating hooks rules. The allocation is negligible — field components
   * do not include `onSave` in any dependency array.
   */
  const deferSaveFor = useCallback(
    (serverConfig: object) => {
      return async (key: EditableConfigKey, value: ConfigValue) => {
        const serverValue = (serverConfig as Record<string, ConfigValue>)[key];
        setDirty(key, value, serverValue);
      };
    },
    [setDirty],
  );

  /** Return dirty value if it exists, else the server value. */
  const dv = useCallback(
    <T extends ConfigValue>(key: EditableConfigKey, serverValue: T): T => {
      if (dirtyFields.has(key)) {
        return dirtyFields.get(key) as T;
      }
      return serverValue;
    },
    [dirtyFields],
  );

  return {
    ...ctx,
    deferSaveFor,
    dv,
  };
}
