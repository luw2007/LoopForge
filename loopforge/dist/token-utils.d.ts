/** Shared token utilities — Jaccard similarity, dedup, vault entry helpers.
 *
 * Single source of truth for tokenization and similarity functions used
 * by the compiler, verification gate, and canonical state renderer.
 *
 * The Unicode token regex covers CJK Unified Ideographs (U+4E00–U+9FFF)
 * plus CJK Extension A (U+3400–U+4DBF), ensuring consistent similarity
 * scores across all modules.
 */
/** Tokenize text into a set of lowercase words and CJK characters.
 *  Regex covers Latin alphanumeric + CJK Unified + CJK Extension A. */
export declare function tokenize(text: string): Set<string>;
/** Jaccard similarity in [0, 1]. Returns 1 when either set is empty
 *  (empty descriptions never match anything, so they don't false-positive). */
export declare function jaccardSimilarity(left: string, right: string): number;
/** Filter null/undefined/empty strings, trim, and deduplicate via Set. */
export declare function unique(values: Array<string | null | undefined>): string[];
/** Narrow `unknown` to a non-array object. Used across storage, MCP, and
 *  transaction modules to validate JSON-deserialized data before field access. */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Extract the round number from a vault entry-like object by reading
 *  `loop_lineage.round` (with `lineage.round` fallback). Returns 0 if
 *  the entry has no recognizable round field. */
export declare function entryRound(entry: Record<string, unknown>): number;
//# sourceMappingURL=token-utils.d.ts.map