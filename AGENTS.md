# BK contributor guide

Read docs/01-PRD.md, docs/02-TECHNICAL-DESIGN.md and docs/IMPLEMENTATION.md before changing behavior. The implementation status document distinguishes tested capabilities from planned scope.

Use Node.js 24+. Install dependencies with npm ci. Run npm run typecheck, npm test and npm run build after functional changes; run npm run format before committing.

Keep sources, snapshots, profiles and model output untrusted. Do not execute source repository scripts. Never write approved knowledge in the user's main worktree or automatically merge a proposal. Do not conflate a scanned revision, completed analysis, submitted proposal and verified merge.

Keep platform CLI adapters behind CLIReviewProvider. Mock tests do not count as live platform validation. Do not introduce undocumented model, Git or browser write permissions.
