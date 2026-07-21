/**
 * The generated Elixir compiler-tracer script (ADR 0011).
 *
 * This string is written to a temp file and run with `mix run <script>` in the
 * target project's directory (see `runner.ts`). It is the one place `unused`
 * executes user code — disclosed in the assumption set, never hidden.
 *
 * What it does, in order:
 *  1. Defines `Unused.Tracer`, a compiler tracer (`Code` moduledoc contract:
 *     `trace/2`) that records `remote_function`/`remote_macro`/
 *     `imported_function`/`local_function`/`alias_reference`/`struct_expansion`
 *     events into an ETS table — module + function + arity + the referencing
 *     site's file/line, plus a `dyn` flag for `apply`/`Module.concat`-style
 *     dynamic-dispatch call sites.
 *  2. Registers the tracer via `Code.put_compiler_option(:tracers, …)` and
 *     force-compiles the project's lib with `Mix.Task.rerun("compile.elixir",
 *     ["--force", "--return-errors"])` inside a temporary build path prepared
 *     by the runner. `compile.elixir` (not the umbrella
 *     `compile` task) is the task that merges the runtime-set tracer option
 *     (verified: the umbrella task drops it).
 *  3. Reflects the compiled BEAM modules for the public-function surface
 *     (`__info__(:functions)`, minus generated `__foo__`/`module_info`
 *     reflection helpers), source file, definition lines (`Code.fetch_docs`),
 *     and behaviour/protocol/impl markers (`__info__(:attributes)`,
 *     `__protocol__/1`, `__impl__/1`) — the hazard-classification inputs.
 *  4. Best-effort compiles the ExUnit test files (under `test/`, `_test.exs`) with the
 *     same tracer to capture the test partition (test → lib references), tagged
 *     `partition: "test"`. Wrapped so a test-compile failure never aborts the
 *     production analysis.
 *  5. Reads the OTP application callback (`:application.get_key(app, :mod)`) and
 *     the declared dependency app names, for entrypoint/Phoenix detection.
 *
 * Output: JSON-lines to the file named by the `UNUSED_OUT` env var — one object
 * per event / module / function / meta record, each tagged with a `k` kind.
 * `:json.encode/1` (OTP 27+) does the encoding; Elixir 1.20/OTP 29 is the
 * verified floor (ADR 0011).
 */

export const TRACER_SCRIPT = `
defmodule Unused.Tracer do
  @moduledoc false
  # Well-known dynamic-dispatch call targets: a call to one of these means the
  # dispatching file could reach a module/function no static reference names.
  @dyn MapSet.new([
    "Kernel.apply/2", "Kernel.apply/3", ":erlang.apply/3",
    "Module.concat/1", "Module.concat/2",
    "String.to_atom/1", "String.to_existing_atom/1"
  ])

  def trace({:remote_function, meta, m, n, a}, env), do: ev("remote", env, meta, m, n, a)
  def trace({:remote_macro, meta, m, n, a}, env), do: ev("remote", env, meta, m, n, a)
  def trace({:imported_function, meta, m, n, a}, env), do: ev("imported", env, meta, m, n, a)
  def trace({:imported_macro, meta, m, n, a}, env), do: ev("imported", env, meta, m, n, a)
  def trace({:local_function, meta, n, a}, env), do: ev("local", env, meta, env.module, n, a)
  def trace({:local_macro, meta, n, a}, env), do: ev("local", env, meta, env.module, n, a)
  def trace({:alias_reference, meta, m}, env), do: ev("alias", env, meta, m, nil, nil)
  def trace({:struct_expansion, meta, m, _keys}, env), do: ev("struct", env, meta, m, nil, nil)
  def trace(_event, _env), do: :ok

  defp ev(kind, env, meta, module, name, arity) do
    line = Keyword.get(meta, :line, env.line) || 0
    tomod = ms(module)
    dyn = MapSet.member?(@dyn, "#{tomod}.#{name}/#{arity}")
    :ets.insert(:unused_events,
      {{kind, to_string(env.file), line, ms(env.module), fnf(env.function), tomod, ns(name), arity, dyn}})
    :ok
  end

  defp ms(nil), do: nil
  defp ms(m) when is_atom(m), do: inspect(m)
  defp ms(m), do: to_string(m)
  defp ns(nil), do: nil
  defp ns(n), do: to_string(n)
  defp fnf(nil), do: nil
  defp fnf({n, a}), do: "#{n}/#{a}"
end

defmodule Unused.Reflect do
  @moduledoc false
  def line_of(a) when is_integer(a), do: a
  def line_of(a) when is_list(a), do: Keyword.get(a, :line, 0)
  def line_of({l, _c}), do: l
  def line_of(_), do: 0

  # Generated / reflection helpers a module always exposes — never claimable.
  def generated?(name) do
    s = to_string(name)
    s in ["module_info", "behaviour_info", "__struct__"] or Regex.match?(~r/^__.*__$/, s)
  end

  # Emit one module record + one record per public, non-generated function.
  def dump_module(emit, mod, root, partition) do
    src = try do to_string(mod.module_info(:compile)[:source]) rescue _ -> "" end
    rel = Path.relative_to(src, root)
    cond do
      src == "" or String.starts_with?(rel, "..") or String.starts_with?(rel, "/") -> :ok
      true ->
        attrs = try do mod.__info__(:attributes) rescue _ -> [] end
        behaviours = Keyword.get_values(attrs, :behaviour) |> List.flatten() |> Enum.map(&inspect/1)
        impl = function_exported?(mod, :__impl__, 1)
        proto = function_exported?(mod, :__protocol__, 1)
        {modline, flines} =
          case Code.fetch_docs(mod) do
            {:docs_v1, anno, _, _, _, _, docs} ->
              fl = for {{:function, n, a}, fa, _, _, _} <- docs, into: %{},
                do: {"#{n}/#{a}", line_of(fa)}
              {line_of(anno), fl}
            _ -> {0, %{}}
          end
        emit.(%{"k" => "module", "mod" => inspect(mod), "file" => rel, "line" => modline,
                "behaviours" => behaviours, "protocol" => proto, "impl" => impl,
                "partition" => partition})
        funs = try do mod.__info__(:functions) rescue _ -> [] end
        Enum.each(funs, fn {n, a} ->
          unless generated?(n) do
            emit.(%{"k" => "function", "mod" => inspect(mod), "name" => to_string(n),
                    "arity" => a, "file" => rel, "line" => Map.get(flines, "#{n}/#{a}", modline),
                    "partition" => partition})
          end
        end)
    end
  end
end

# --- output sink -----------------------------------------------------------
out = System.get_env("UNUSED_OUT")
{:ok, io} = File.open(out, [:write, :utf8])
emit = fn map -> IO.puts(io, IO.iodata_to_binary(:json.encode(map))) end
root = File.cwd!()

# --- compile lib with the tracer -------------------------------------------
:ets.new(:unused_events, [:public, :named_table, :duplicate_bag, write_concurrency: true])
Code.put_compiler_option(:tracers, [Unused.Tracer])

compile_ok =
  case Mix.Task.rerun("compile.elixir", ["--force", "--return-errors"]) do
    {:error, diagnostics} when is_list(diagnostics) and diagnostics != [] ->
      emit.(%{"k" => "compile_error", "count" => length(diagnostics),
              "details" => Enum.map(diagnostics, &inspect/1)})
      false
    _ -> true
  end

# The runner deliberately entered with no application artifacts in
# the isolated build. Generate the .app resource there so application callback
# discovery below remains compiler-backed without touching the project's build.
if compile_ok, do: Mix.Task.rerun("compile.app", ["--force"])

emit.(%{"k" => "meta", "compile_ok" => compile_ok})

# --- application callback + dependency app names ----------------------------
app = Mix.Project.config()[:app]

case app && :application.get_key(app, :mod) do
  {:ok, {mod, _args}} -> emit.(%{"k" => "app_mod", "mod" => inspect(mod)})
  _ -> :ok
end

deps =
  (Mix.Project.config()[:deps] || [])
  |> Enum.map(fn t -> elem(t, 0) end)
  |> Enum.map(&to_string/1)

emit.(%{"k" => "deps", "names" => deps})

# --- production events + module/function definitions ------------------------
:ets.tab2list(:unused_events)
|> Enum.map(fn {t} -> t end)
|> Enum.each(fn {kind, file, line, from_mod, from_fun, to_mod, name, arity, dyn} ->
  base = %{"k" => "event", "kind" => kind, "file" => Path.relative_to(file, root),
           "line" => line, "from_mod" => from_mod, "to_mod" => to_mod, "dyn" => dyn,
           "partition" => "prod"}
  base = if from_fun, do: Map.put(base, "from_fun", from_fun), else: base
  base = if name, do: Map.put(base, "name", name), else: base
  base = if arity != nil, do: Map.put(base, "arity", arity), else: base
  emit.(base)
end)

ebin = Mix.Project.compile_path()
lib_mods =
  Path.wildcard(Path.join(ebin, "*.beam"))
  |> Enum.map(fn p -> p |> Path.basename(".beam") |> String.to_atom() end)

Enum.each(lib_mods, fn mod ->
  Code.ensure_loaded(mod)
  Unused.Reflect.dump_module(emit, mod, root, "prod")
end)

# --- test partition (best effort, fully isolated) --------------------------
# ExUnit test files are compiled in MIX_ENV=test and NOT part of mix compile,
# so compile them separately with the same tracer. This is STRICTLY best
# effort: a real app's test file often runs module-level code (a factory
# calling a GenServer) that, under --no-start, EXITS rather than raises. An
# exit from a linked ParallelCompiler worker would kill this whole process and
# fail the analysis — so the test compile runs inside a MONITORED child
# process. A crash there sends us a :DOWN we absorb; production analysis
# (already fully emitted above) always stands.
test_files = Path.wildcard("test/**/*_test.exs")

if test_files != [] do
  :ets.delete_all_objects(:unused_events)
  parent = self()
  {pid, ref} =
    spawn_monitor(fn ->
      try do
        Application.ensure_all_started(:ex_unit)
        helper = "test/test_helper.exs"
        if File.exists?(helper), do: Code.require_file(helper)
        result = Kernel.ParallelCompiler.compile(test_files, tracers: [Unused.Tracer])
        send(parent, {:test_result, result})
      catch
        _kind, _reason -> send(parent, {:test_result, :error})
      end
    end)

  {mods, ok} =
    receive do
      {:test_result, {:ok, test_mods, _warnings}} -> {test_mods, true}
      {:test_result, _} -> {[], false}
      {:DOWN, ^ref, :process, ^pid, _reason} -> {[], false}
    after
      120_000 -> {[], false}
    end

  if ok do
    :ets.tab2list(:unused_events)
    |> Enum.map(fn {t} -> t end)
    |> Enum.each(fn {kind, file, line, from_mod, from_fun, to_mod, name, arity, dyn} ->
      base = %{"k" => "event", "kind" => kind, "file" => Path.relative_to(file, root),
               "line" => line, "from_mod" => from_mod, "to_mod" => to_mod, "dyn" => dyn,
               "partition" => "test"}
      base = if from_fun, do: Map.put(base, "from_fun", from_fun), else: base
      base = if name, do: Map.put(base, "name", name), else: base
      base = if arity != nil, do: Map.put(base, "arity", arity), else: base
      emit.(base)
    end)
    Enum.each(mods, fn mod ->
      try do
        Code.ensure_loaded(mod)
        Unused.Reflect.dump_module(emit, mod, root, "test")
      catch
        _k, _r -> :ok
      rescue
        _ -> :ok
      end
    end)
  else
    emit.(%{"k" => "test_compile_error"})
  end
end

File.close(io)
`;
