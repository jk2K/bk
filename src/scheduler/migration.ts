import type { Source } from "../config/index.js";
import type { State } from "../state/index.js";
import { hash } from "../util.js";

export function sourceFingerprint(source: Source) {
  return hash(
    JSON.stringify([
      source.type,
      source.url,
      source.type === "git" ? source.branch : source.browser.profile,
      source.include,
      source.exclude,
      source.type === "web" ? source.crawl : null,
    ]),
  );
}

export function migrateSource(
  state: State,
  source: Source,
  expectedRevision: string,
) {
  const prior = state.getSource(source.id);
  if (!prior?.revision || prior.revision !== expectedRevision)
    throw new Error("Migration requires the current scanned revision");
  const fingerprint = sourceFingerprint(source);
  if (prior.fingerprint === fingerprint)
    throw new Error("Source scope is unchanged");
  if (
    state.db
      .prepare(
        "SELECT 1 FROM proposals p LEFT JOIN proposal_events e ON e.proposal_id=p.id JOIN changes c ON c.id=COALESCE(e.change_id,p.change_id) WHERE c.source_id=? AND p.status='prepared'",
      )
      .get(source.id)
  )
    throw new Error(
      "Recover the prepared proposal before migrating its source",
    );
  state.transaction(() => {
    state.db
      .prepare(
        "INSERT INTO source_generations VALUES(?,1,1) ON CONFLICT(source_id) DO UPDATE SET generation=generation+1,pending=1",
      )
      .run(source.id);
    state.db
      .prepare(
        "UPDATE changes SET status='superseded' WHERE source_id=? AND status NOT IN ('done','superseded')",
      )
      .run(source.id);
    state.db
      .prepare(
        "UPDATE sources SET fingerprint=?, revision=NULL, status='migration_pending', error=NULL, due=0, attempts=0 WHERE id=?",
      )
      .run(fingerprint, source.id);
    state.event("source_migrated", {
      source: source.id,
      previousRevision: prior.revision,
      previousFingerprint: prior.fingerprint,
      fingerprint,
    });
  });
}
