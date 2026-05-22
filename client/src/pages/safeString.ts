/**
 * safeString.ts
 * ─────────────────────────────────────────────────────────────────
 * Utilitários de coerção segura para valores vindos do Excel/JSON.
 *
 * REGRA DE OURO: nunca chame .toLowerCase(), .toUpperCase(),
 * .trim() ou qualquer método de string diretamente em valores
 * que passaram por uma planilha — sempre passe por safeStr() antes.
 * ─────────────────────────────────────────────────────────────────
 */

/**
 * Converte QUALQUER valor para string de forma segura.
 *
 * null / undefined / ""  → fallback (padrão "")
 * number                 → String(n)
 * boolean                → "true" / "false"
 * Date                   → "YYYY-MM-DD"
 * object                 → JSON compacto
 */
export function safeStr(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? fallback : trimmed;
  }
  if (typeof value === "number") return isFinite(value) ? String(value) : fallback;
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? fallback : value.toISOString().split("T")[0];
  }
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return fallback; }
  }
  return fallback;
}

/** safeStr + toLowerCase — para comparações e chaves de lookup */
export const safeStrLower = (value: unknown, fallback = ""): string =>
  safeStr(value, fallback).toLowerCase();

/** safeStr + toUpperCase — para exibição de categorias, badges */
export const safeStrUpper = (value: unknown, fallback = ""): string =>
  safeStr(value, fallback).toUpperCase();

/** safeStr + trim explícito (redundante, mas deixa a intenção clara) */
export const safeStrTrim = (value: unknown, fallback = ""): string =>
  safeStr(value, fallback).trim();
