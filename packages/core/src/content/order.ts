/**
 * The canonical order the content layer exposes things in (ADR-0024 §2).
 *
 * One comparator behind every sorted exposure in the content layer: the ids of
 * a collection, the ids inside a tag bucket, the keys of a merged tag list.
 * Plain code-point comparison — no locale, no collation — so the same content
 * produces the same bytes on every machine and in every run.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
