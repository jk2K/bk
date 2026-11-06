import type { Config } from "../config/index.js";
import { assertTransmission } from "../agent/runtime.js";
import type { State } from "../state/index.js";
import { sourceFingerprint } from "./migration.js";
import type { ChangeSet } from "../sources/git.js";

export function attachContext(state: State, change: ChangeSet, config: Config) {
  const group = config.sources.find(
    (source) => source.id === change.source.id,
  )?.analysis_group;
  change.related = [];
  if (group) {
    for (const source of config.sources
      .filter((s) => s.analysis_group === group && s.id !== change.source.id)
      .slice(0, 8)) {
      const snapshot = state.getSource(source.id);
      if (
        !snapshot?.revision ||
        snapshot.fingerprint !== sourceFingerprint(source)
      )
        continue;
      const rows = state.db
        .prepare(
          "SELECT payload FROM changes WHERE source_id=? AND revision=? AND status NOT IN ('superseded','blocked') ORDER BY rowid DESC LIMIT 8",
        )
        .all(source.id, snapshot.revision) as Array<{ payload: string }>;
      for (const row of rows) {
        const other = JSON.parse(row.payload) as ChangeSet;
        if (
          other.source.url !== source.url ||
          other.source.role !== source.role ||
          other.source.analysis_group !== group
        )
          continue;
        try {
          assertTransmission(source, config);
          assertTransmission(other.source, config);
        } catch {
          continue;
        }
        change.related.push(other);
      }
    }
  }
  const rows = state.db
    .prepare(
      "SELECT decision,payload FROM review_feedback ORDER BY rowid DESC LIMIT 30",
    )
    .all() as Array<{ decision: string; payload: string }>;
  change.feedback = rows
    .flatMap((row) =>
      JSON.parse(row.payload).actions.map(
        (action: {
          sourceId: string;
          ruleId: string;
          statementHash: string;
        }) => ({ ...action, decision: row.decision }),
      ),
    )
    .filter((action) => action.sourceId === change.source.id)
    .slice(0, 30);
}
