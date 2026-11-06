import type { State } from "./index.js";
export function metrics(state: State) {
  const countBy = (table: "changes" | "proposals" | "sources") =>
    state.db
      .prepare(
        `SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status ORDER BY status`,
      )
      .all();
  return {
    sources: countBy("sources"),
    events: countBy("changes"),
    proposals: countBy("proposals"),
    reviews: state.db
      .prepare(
        "SELECT decision,COUNT(*) AS count FROM review_feedback GROUP BY decision",
      )
      .all(),
    runs: state.db
      .prepare(
        `SELECT COUNT(*) AS count,
      COALESCE(SUM(json_extract(payload,'$.failed')),0) AS failed,
      COALESCE(SUM(json_extract(payload,'$.modelJobs')),0) AS modelSessions,
      AVG(json_extract(payload,'$.durationMs')) AS meanDurationMs
      FROM history WHERE kind='run'`,
      )
      .get(),
    usage: state.db
      .prepare(
        `SELECT kind,
      SUM(json_extract(payload,'$.usage.usage.input_tokens')) AS inputTokens,
      SUM(json_extract(payload,'$.usage.usage.output_tokens')) AS outputTokens,
      SUM(json_extract(payload,'$.usage.cost')) AS costUsd
      FROM history WHERE kind IN ('analysis','browser_usage','image_analysis') GROUP BY kind`,
      )
      .all(),
  };
}
