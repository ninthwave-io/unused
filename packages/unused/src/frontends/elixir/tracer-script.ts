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
 *  3. Reads each compiled BEAM path without loading it: `:beam_lib` supplies
 *     module/compile-info/attribute/export metadata and `Code.fetch_docs/1`
 *     reads the path's EEP-48 docs chunk for definition lines. This recovers
 *     the public-function surface and behaviour/protocol/impl markers without
 *     executing module `@on_load` hooks.
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

  # Emit one module record + one record per public, non-generated function by
  # reading the BEAM file only. Nothing in this function loads module code.
  def dump_beam(emit, path, root, partition) do
    try do
      with {:ok, {mod, chunks}} <-
             :beam_lib.chunks(String.to_charlist(path), [:compile_info, :attributes, :exports]),
           compile_info when is_list(compile_info) <- Keyword.fetch!(chunks, :compile_info),
           attrs when is_list(attrs) <- Keyword.fetch!(chunks, :attributes),
           exports when is_list(exports) <- Keyword.fetch!(chunks, :exports),
           source when is_list(source) or is_binary(source) <- Keyword.fetch!(compile_info, :source),
           src when src != "" <- source |> to_string() |> Path.expand(),
           rel <- Path.relative_to(src, Path.expand(root)),
           false <- rel == "." or rel == ".." or String.starts_with?(rel, "../") or
                    String.starts_with?(rel, "/"),
           {:ok, {behaviours, protocol, impl}} <- attributes(attrs),
           true <- is_atom(mod),
           true <- valid_exports?(exports) do
        {modline, flines} = docs(path)
        emit.(%{"k" => "module", "mod" => inspect(mod), "file" => rel, "line" => modline,
                "behaviours" => Enum.map(behaviours, &inspect/1),
                "protocol" => protocol,
                "impl" => impl,
                "partition" => partition})
        exports
        |> Enum.sort()
        |> Enum.each(fn {name, arity} ->
          unless generated?(name) or String.starts_with?(to_string(name), "MACRO-") do
            emit.(%{"k" => "function", "mod" => inspect(mod), "name" => to_string(name),
                    "arity" => arity, "file" => rel,
                    "line" => Map.get(flines, "#{name}/#{arity}", modline),
                    "partition" => partition})
          end
        end)
        :ok
      else
        _ -> {:error, :reflection}
      end
    rescue
      _ -> {:error, :reflection}
    catch
      _, _ -> {:error, :reflection}
    end
  end

  defp attributes(attrs) do
    with true <- Keyword.keyword?(attrs),
         behaviour_groups <-
           Keyword.get_values(attrs, :behaviour) ++ Keyword.get_values(attrs, :behavior),
         true <- Enum.all?(behaviour_groups, &is_list/1),
         behaviours <- List.flatten(behaviour_groups),
         true <- Enum.all?(behaviours, &is_atom/1),
         {:ok, protocol} <- protocol_attribute(Keyword.get_values(attrs, :__protocol__)),
         {:ok, impl} <- impl_attribute(Keyword.get_values(attrs, :__impl__)) do
      {:ok, {behaviours, protocol, impl}}
    else
      _ -> {:error, :attributes}
    end
  end

  defp protocol_attribute([]), do: {:ok, false}
  defp protocol_attribute([[fallback_to_any: fallback]]) when is_boolean(fallback), do: {:ok, true}
  defp protocol_attribute(_), do: {:error, :protocol_attribute}

  defp impl_attribute([]), do: {:ok, false}
  defp impl_attribute([[protocol: protocol, for: target]])
       when is_atom(protocol) and is_atom(target), do: {:ok, true}
  defp impl_attribute(_), do: {:error, :impl_attribute}

  defp docs(path) do
    case Code.fetch_docs(path) do
      {:docs_v1, anno, _, _, _, _, docs} when is_list(docs) ->
        flines =
          Enum.reduce(docs, %{}, fn
            {{:function, name, arity}, function_anno, _, _, metadata}, acc
                when is_atom(name) and is_integer(arity) and is_map(metadata) ->
              line = definition_line(function_anno, metadata)
              defaults = Map.get(metadata, :defaults, 0)
              if is_integer(defaults) and defaults >= 0 and defaults <= arity do
                Enum.reduce((arity - defaults)..arity, acc, fn actual_arity, lines ->
                  Map.put(lines, "#{name}/#{actual_arity}", line)
                end)
              else
                acc
              end
            _, acc ->
              acc
          end)
        {line_of(anno), flines}
      _ ->
        {0, %{}}
    end
  end

  defp definition_line(_fallback, %{source_annos: [source_anno | _]}) do
    line_of(source_anno)
  end
  defp definition_line(fallback, _metadata), do: line_of(fallback)

  defp valid_exports?(exports) do
    Enum.all?(exports, fn
      {name, arity} when is_atom(name) and is_integer(arity) and arity >= 0 -> true
      _ -> false
    end)
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
        |> Enum.reduce_while(true, fn path, _acc ->
          with :ok <- Unused.Reflect.dump_beam(emit, path, root, "prod") do
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

    {_test_mods, tests_ok} =
      if support_ok do
        parent = self()
        {pid, ref} =
          spawn_monitor(fn ->
            try do
              Application.ensure_all_started(:ex_unit)
              ExUnit.start(autorun: false)
              result = Kernel.ParallelCompiler.compile_to_path(
                test_files, Mix.Project.compile_path(), tracers: [Unused.Tracer])
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
      Mix.Project.compile_path()
      |> Path.join("*.beam")
      |> Path.wildcard()
      |> Enum.sort()
      |> Enum.reduce_while(true, fn path, _acc ->
        with :ok <- Unused.Reflect.dump_beam(emit, path, root, "test") do
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
