import type { ChangeSet } from "../sources/git.js";
import type { Rule } from "./index.js";
function terms(text: string) {
  const out = new Set(text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []);
  for (const segment of text.match(/[\p{Script=Han}]+/gu) ?? [])
    for (let i = 0; i < segment.length - 1; i++)
      out.add(segment.slice(i, i + 2));
  return out;
}
const locator = (s: string) => s.split("#")[0];
export class RuleIndex {
  readonly bySource = new Map<string, Map<string, Set<string>>>();
  constructor(readonly rules: Rule[]) {
    for (const r of rules)
      for (const ref of r.meta.sources ?? []) {
        if (
          typeof ref.source_id !== "string" ||
          typeof ref.locator !== "string"
        )
          continue;
        const paths =
          this.bySource.get(ref.source_id) ?? new Map<string, Set<string>>();
        const ids = paths.get(locator(ref.locator)) ?? new Set<string>();
        ids.add(r.id);
        paths.set(locator(ref.locator), ids);
        this.bySource.set(ref.source_id, paths);
      }
  }
  find(change: ChangeSet, limit = 30) {
    const direct = new Set<string>();
    const map = this.bySource.get(change.source.id);
    for (const e of change.evidence)
      for (const path of [e.locator, e.oldLocator].filter(
        (p): p is string => !!p,
      ))
        for (const id of map?.get(locator(path)) ?? []) direct.add(id);
    const query = terms(
      change.evidence
        .map((e) => e.locator + " " + e.before + " " + e.after)
        .join("\n")
        .slice(0, 200000),
    );
    const scored = this.rules
      .map((rule) => {
        const words = terms(
          rule.id + " " + rule.meta.title + " " + rule.statement,
        );
        let score = 0;
        for (const w of words) if (query.has(w)) score++;
        return { rule, score };
      })
      .filter((r) => direct.has(r.rule.id) || r.score > 0)
      .sort(
        (a, b) =>
          Number(direct.has(b.rule.id)) - Number(direct.has(a.rule.id)) ||
          b.score - a.score ||
          a.rule.id.localeCompare(b.rule.id),
      );
    if (direct.size > limit)
      throw new Error("Related rule budget exceeded; narrow the source scope");
    const chosen = scored.slice(0, limit).map((x) => x.rule),
      ids = new Set(chosen.map((r) => r.id));
    for (const r of [...chosen])
      for (const id of r.meta.related_rules ?? []) {
        const related = this.rules.find((x) => x.id === id);
        if (related && !ids.has(id)) {
          if (chosen.length >= limit)
            throw new Error("Related rule graph budget exceeded");
          chosen.push(related);
          ids.add(id);
        }
      }
    return chosen;
  }
}
