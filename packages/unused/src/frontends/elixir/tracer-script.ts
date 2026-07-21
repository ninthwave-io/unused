/**
 * The generated Elixir compiler-tracer script (ADR 0011).
 *
 * This string is written to a temp file and run with `mix run <script>` in the
 * target project's directory (see `runner.ts`). It is the one place `unused`
 * executes user code — disclosed in the assumption set, never hidden.
 *
 * What it does for the phase selected by `UNUSED_PHASE`:
 *  1. Defines `Unused.Tracer`, a compiler tracer (`Code` moduledoc contract:
 *     `trace/2`) that records `remote_function`/`remote_macro`/
 *     `imported_function`/`local_function`/`alias_reference`/`struct_expansion`
 *     events into an ETS table — module + function + arity + the referencing
 *     site's file/line, plus a `dyn` flag for `apply`/`Module.concat`-style
 *     dynamic-dispatch call sites.
 *  2. Registers the tracer via `Code.put_compiler_option(:tracers, …)` and
 *     force-compiles the phase's effective `elixirc_paths` with
 *     `Mix.Task.rerun("compile.elixir", ["--force", "--return-errors"])`
 *     inside a temporary build path prepared by the runner. `compile.elixir` (not the umbrella
 *     `compile` task) is the task that merges the runtime-set tracer option
 *     (verified: the umbrella task drops it).
 *  3. Reflects the compiled BEAM modules for the public-function surface
 *     (`__info__(:functions)`, minus generated `__foo__`/`module_info`
 *     reflection helpers), source file, definition lines (`Code.fetch_docs`),
 *     and behaviour/protocol/impl markers (`__info__(:attributes)`,
 *     `__protocol__/1`, `__impl__/1`) — the hazard-classification inputs.
 *  4. In the production child, reads the OTP application callback and declared
 *     dependency names. In the separate test child, compiles only the runner's
 *     sorted ExUnit inventory after the effective test support paths, without
 *     requiring `test_helper.exs` or starting the target application.
 *
 * Output: JSON-lines to the file named by the `UNUSED_OUT` env var — one object
 * per phase/event/module/function/meta record, each tagged with a `k` kind.
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
    try do
      src = to_string(mod.module_info(:compile)[:source])
      rel = Path.relative_to(src, root)
      cond do
        src == "" or String.starts_with?(rel, "..") or String.starts_with?(rel, "/") ->
          {:error, :external_source}
        true ->
        attrs = mod.__info__(:attributes)
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
        funs = mod.__info__(:functions)
        Enum.each(funs, fn {n, a} ->
          unless generated?(n) do
            emit.(%{"k" => "function", "mod" => inspect(mod), "name" => to_string(n),
                    "arity" => a, "file" => rel, "line" => Map.get(flines, "#{n}/#{a}", modline),
                    "partition" => partition})
          end
        end)
        :ok
      end
    rescue
      _ -> {:error, :reflection}
    catch
      _, _ -> {:error, :reflection}
    end
  end
end

defmodule Unused.Output do
  @moduledoc false

  def dump_events(emit, root, partition) do
    :ets.tab2list(:unused_events)
    |> Enum.map(fn {event} -> event end)
    |> Enum.sort()
    |> Enum.each(fn {kind, file, line, from_mod, from_fun, to_mod, name, arity, dyn} ->
      base = %{"k" => "event", "kind" => kind, "file" => Path.relative_to(file, root),
               "line" => line, "from_mod" => from_mod, "to_mod" => to_mod, "dyn" => dyn,
               "partition" => partition}
      base = if from_fun, do: Map.put(base, "from_fun", from_fun), else: base
      base = if name, do: Map.put(base, "name", name), else: base
      base = if arity != nil, do: Map.put(base, "arity", arity), else: base
      emit.(base)
    end)
  end
end

# --- output sink -----------------------------------------------------------
out = System.get_env("UNUSED_OUT")
{:ok, io} = File.open(out, [:write, :utf8])
emit = fn map -> IO.puts(io, IO.iodata_to_binary(:json.encode(map))) end
root = File.cwd!()
phase = System.get_env("UNUSED_PHASE") || "production"
emit.(%{"k" => "phase", "phase" => phase, "status" => "started"})

:ets.new(:unused_events, [:public, :named_table, :duplicate_bag, write_concurrency: true])
Code.put_compiler_option(:tracers, [Unused.Tracer])

case phase do
  "production" ->
    compile_ok =
      case Mix.Task.rerun("compile.elixir", ["--force", "--return-errors"]) do
        {:error, diagnostics} when is_list(diagnostics) and diagnostics != [] ->
          emit.(%{"k" => "compile_error", "count" => length(diagnostics),
                  "details" => Enum.map(diagnostics, &inspect/1)})
          false
        _ -> true
      end

    # Generate the isolated .app resource for compiler-backed callback lookup.
    if compile_ok, do: Mix.Task.rerun("compile.app", ["--force"])

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

    reflection_ok =
      if compile_ok do
        Unused.Output.dump_events(emit, root, "prod")
        Mix.Project.compile_path()
        |> Path.join("*.beam")
        |> Path.wildcard()
        |> Enum.sort()
        |> Enum.map(fn path -> path |> Path.basename(".beam") |> String.to_atom() end)
        |> Enum.reduce_while(true, fn mod, _acc ->
          with {:module, ^mod} <- Code.ensure_loaded(mod),
               :ok <- Unused.Reflect.dump_module(emit, mod, root, "prod") do
            {:cont, true}
          else
            _ -> {:halt, false}
          end
        end)
      else
        false
      end

    complete = compile_ok and reflection_ok
    if compile_ok and not reflection_ok do
      emit.(%{"k" => "compile_error", "count" => 1,
              "details" => ["module reflection incomplete"]})
    end
    emit.(%{"k" => "meta", "compile_ok" => complete})
    emit.(%{"k" => "phase", "phase" => "production",
            "status" => if(complete, do: "complete", else: "incomplete")})

  "test" ->
    inventory =
      System.fetch_env!("UNUSED_INVENTORY")
      |> File.read!()
      |> :json.decode()
    test_files = Map.fetch!(inventory, "testFiles") |> Enum.sort()

    support_ok =
      case Mix.Task.rerun("compile.elixir", ["--force", "--return-errors"]) do
        {:error, _diagnostics} -> false
        _ -> true
      end

    {test_mods, tests_ok} =
      if support_ok do
        parent = self()
        {pid, ref} =
          spawn_monitor(fn ->
            try do
              Application.ensure_all_started(:ex_unit)
              ExUnit.start(autorun: false)
              result = Kernel.ParallelCompiler.compile(test_files, tracers: [Unused.Tracer])
              send(parent, {:test_result, result})
            catch
              _kind, _reason -> send(parent, {:test_result, :error})
            end
          end)

        receive do
          {:test_result, {:ok, modules, _warnings}} -> {modules, true}
          {:test_result, _} -> {[], false}
          {:DOWN, ^ref, :process, ^pid, _reason} -> {[], false}
        after
          120_000 -> {[], false}
        end
      else
        {[], false}
      end

    compile_complete = support_ok and tests_ok
    reflection_ok =
      if compile_complete do
      support_mods =
        Mix.Project.compile_path()
        |> Path.join("*.beam")
        |> Path.wildcard()
        |> Enum.sort()
        |> Enum.map(fn path -> path |> Path.basename(".beam") |> String.to_atom() end)

      (support_mods ++ test_mods)
      |> Enum.uniq()
      |> Enum.sort()
      |> Enum.reduce_while(true, fn mod, _acc ->
        with {:module, ^mod} <- Code.ensure_loaded(mod),
             :ok <- Unused.Reflect.dump_module(emit, mod, root, "test") do
          {:cont, true}
        else
          _ -> {:halt, false}
        end
      end)
      else
        false
      end

    complete = compile_complete and reflection_ok
    if complete do
      Unused.Output.dump_events(emit, root, "test")
    else
      emit.(%{"k" => "test_compile_error"})
    end
    emit.(%{"k" => "phase", "phase" => "test",
            "status" => if(complete, do: "complete", else: "incomplete")})

  _ ->
    emit.(%{"k" => "phase", "phase" => phase, "status" => "incomplete"})
end

File.close(io)
`;
