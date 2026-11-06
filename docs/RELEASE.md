# Release preparation

Develop with Node 24 and Git. Run `npm ci`, `npm run typecheck`, and `npm test`. Install Chromium and ffmpeg for `npm run validate:artifacts`. Run `npm run eval:codex -- --self-test` to check the evaluation schema and scorer. See [the evaluation guide](../evaluation/README.md) for real-model scoring.

Run `npm run release:check` to create a tarball in an isolated temporary directory, check its file list, and smoke-test the packaged CLI with the locked development dependencies. To retain the distribution, run `npm pack`. Generate the dependency inventory with `npm sbom --sbom-format cyclonedx --omit=dev` and review it with the release.

The package is private and uses `UNLICENSED` while the repository owner selects a license. Before public distribution, record the approved license and publisher, add the corresponding LICENSE and dependency notices, validate installation of the tarball on the supported platforms, and complete the real-service acceptance checks in [VALIDATION-GAPS.md](VALIDATION-GAPS.md). Then remove the private flag, tag the reviewed commit, and publish the reviewed distribution through the owner's npm account. The existing CLI commands accept 0.2 configuration and state. Back up the local SQLite state before rolling back across versions.

See the [changelog](../CHANGELOG.md) for version changes. The sample evaluation stores short source summaries and links to the original project.
