/**
 * The engine's ONE markup factory (spec/05 §8.2, issue #54). Every markup
 * token the engine ever recognises — today the render templates'
 * placeholders, tomorrow whatever string-marked face may come — is a key
 * wrapped in NUL, a code point from the Cc category.
 *
 * The isolation is CONSTRUCTIVE, the §8.2 star: sanitizePlayerInput
 * (../input/sanitize.ts) drops every Cc/Cf code point from a player's line
 * BEFORE the engine sees it, so a player cannot type markup not because a
 * regex patrols for it, but because the markup's own code points cannot
 * survive the input gate. A PUA scheme would NOT close this loop — PUA is
 * not a control category, nothing strips it, and making it "unreachable"
 * would mean hand-listing it, the very blacklist shape §8.1 forbids.
 *
 * This module is the single source of the markup alphabet: the recogniser
 * (render's templateSpans) accepts exactly what this factory emits, and
 * anything a player could type renders as plain text by construction.
 */

/**
 * Wraps a placeholder key in NUL: THE engine markup token shape.
 * Hosts and tests build template strings through this factory only — a
 * bare `{key}` in a template is plain text since #54, not a placeholder.
 */
export function markupKey(key: string): string {
  return `\x00${key}\x00`;
}

/**
 * The recogniser's pattern — exactly what markupKey emits, nothing else.
 * Module-private ON PURPOSE: a shared /g regex carries lastIndex across
 * callers, so the public face is the function below, never the regex.
 */
const MARKUP_TOKEN = /\x00([a-zA-Z]+)\x00/g;

/**
 * Iterates a template's markup tokens (the recogniser half of the one
 * alphabet home: if the shape ever changes, the factory and this walk
 * change together or not at all).
 */
export function matchMarkupTokens(template: string): IterableIterator<RegExpMatchArray> {
  return template.matchAll(MARKUP_TOKEN);
}
