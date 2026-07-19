# HEEx visibility experiment (ADR 0011)

**Question (ADR 0011, flagged UNVERIFIED):** do `~H`/`.heex` component
references fire compiler-tracer events, or are templates invisible to the
reference graph (which would force a project-scope hazard for every Phoenix app)?

**Answer: VISIBLE.** Empirically confirmed on Elixir 1.20.2 / OTP 29 with
`phoenix_live_view ~> 1.0`:

- `<.greeting name="world" />` (a local function-component invocation inside a
  `~H` sigil) compiles to an **`imported_function` tracer event** targeting
  `HeexExp.Components.greeting/1`.
- `<HeexExp.Components.greeting … />` (explicit module form) compiles to a
  **`remote_function` event**.
- A component referenced only from a **separate `.heex` template file**
  (`embed_templates`) still fires the event, attributed to the embedding
  module's function (`env.file` is the `.heex` path, `env.module`/`env.function`
  are the compiled component function).
- An **unreferenced** component (`unused_component/1` here) has no inbound event
  and is correctly claimed dead.

**Consequence for the frontend:** HEEx templates need **no** special handling
and **no** project-scope hazard. `use Phoenix.Component` declares no behaviour,
so function components stay claimable; only `Phoenix.LiveView`/`LiveComponent`/
`Channel` (behaviour-declaring, runtime-dispatched) modules get the
`elixir-phoenix-runtime` keep-alive. This is recorded in the assumption set
(`elixir-entrypoints-and-runtime-dispatch`) and supersedes the "treat as a
project-scope hazard until proven" stance in ADR 0011 §Decision.

This fixture is the reproducible experiment: `greeting/1` is labelled `alive`
(reference visible) and `unused_component/1` is labelled `dead`.
