# Codex SDK business evaluation v1

The eight cases use the pinned Codex repository revision, the supplied ChatGPT Learn SDK page and open feature requests selected from the supplied issue search. Evidence entries are short paraphrases and identify the URL, immutable Git revision or observed document hash, and issue update timestamp. The HTML hash identifies the observed response, including site markup. Issue labels represent their state at capture.

Cases cover evidence attribution, feature-request status, behavior established jointly by code and documentation, and unsupported claims. Verdicts and evidence requirements are authored reference labels. A passing case requires the correct verdict, the exact set of supported claims, and all required evidence references without invented references.

- `npm run eval:codex -- --self-test` checks that the scorer accepts the reference answers and rejects forged evidence. This measures the scorer.
- `npm run eval:codex -- --live --output .bk/codex-eval.json` sends only the public case input and allowed evidence to the configured Claude Agent runtime. Each case has a USD 0.50 SDK budget. Use `--model <name>` to specify a model.
- `npm run eval:codex -- --predictions predictions.json` scores an external prediction file keyed by case ID. Each value has `verdict`, `claims` and `evidence` fields.

The runner withholds expected labels from the live prompt. Scores describe these eight evidence judgments. Production knowledge-proposal quality and generalization require further evaluation on held-out business samples.
