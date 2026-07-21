# Neutral convention-plugin fixture template

Copy this directory to `fixtures/<language-or-polyglot>/<case-name>/`; do not
score the template itself. Replace `neutral-*` placeholders with independently
generated names that describe only the public convention being tested.

Minimum case shape:

```text
<case-name>/
  <language manifest>
  src/
    entry.<ext>       # production/config/test root
    live.<ext>        # reached only through the convention
    dead.<ext>        # similar-looking inverse that must remain claimable
  <public carrier>    # workflow/config/manifest/runtime registration
  labels.yaml
```

For a bridge, use one directory per language and label both sides of one live
pair and one dead pair. Include a mutation/inverse test that removes only the
carrier or caller while leaving containing files live, so a passing result
cannot be explained by whole-file reachability.

Required review checks:

- The fixture compiles or parses with standard local tooling.
- No network dependency is needed when a tiny neutral local stub can preserve
  the public syntax under test.
- At least one `expected: alive` label catches dangerous overclaiming.
- Every expected dead subject has `minConfidence` and a concrete `because`.
- Exact sites appear in `why`; live deletion is refused or fully modelled.
- Names, paths, source, configuration, comments, labels, and prose contain no
  consuming-project material.

Start `labels.yaml` from `labels.yaml.example` in this directory.
