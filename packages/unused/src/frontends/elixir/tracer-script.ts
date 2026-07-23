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
 *     site's file/line, plus a `dyn` flag for invocation primitives and the
 *     `Module.concat` proxy needed for dynamic remote calls.
 *     `:on_module` facts capture compiler-time source ownership before a later
 *     definition can replace the module's final BEAM.
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
  # Well-known dynamic invocation targets. Module.concat and function-scoped
  # atom producers remain conservative proxies because calls such as
  # String.to_atom(name).run() emit no separate outer compiler event. At module
  # scope those atom facts are compile-time name production (for example a
  # generated function name), not runtime dispatch.
  @dyn MapSet.new([
    "Kernel.apply/2", "Kernel.apply/3", ":erlang.apply/3",
    "Module.concat/1", "Module.concat/2",
    "String.to_atom/1", "String.to_existing_atom/1"
  ])
  @function_scoped_dyn MapSet.new(["String.to_atom/1", "String.to_existing_atom/1"])

  def trace({:remote_function, meta, m, n, a}, env), do: ev("remote", "function", env, meta, m, n, a)
  def trace({:remote_macro, meta, m, n, a}, env), do: ev("remote", "macro", env, meta, m, n, a)
  def trace({:imported_function, meta, m, n, a}, env), do: ev("imported", "function", env, meta, m, n, a)
  def trace({:imported_macro, meta, m, n, a}, env), do: ev("imported", "macro", env, meta, m, n, a)
  def trace({:local_function, meta, n, a}, env), do: ev("local", "function", env, meta, env.module, n, a)
  def trace({:local_macro, meta, n, a}, env), do: ev("local", "macro", env, meta, env.module, n, a)
  def trace({:alias_reference, meta, m}, env), do: ev("alias", nil, env, meta, m, nil, nil)
  def trace({:struct_expansion, meta, m, _keys}, env), do: ev("struct", nil, env, meta, m, nil, nil)
  def trace({:on_module, _bytecode, _warnings}, env), do: owner(env)
  def trace(_event, _env), do: :ok

  defp owner(%{module: module, file: file}) when is_atom(module) do
    :ets.insert(:unused_owners, {{inspect(module), to_string(file)}})
    :ok
  end
  defp owner(_env), do: :ok

  defp ev(kind, call_kind, env, meta, module, name, arity) do
    line = Keyword.get(meta, :line, env.line) || 0
    column = Keyword.get(meta, :column, 0) || 0
    tomod = ms(module)
    target = "#{tomod}.#{name}/#{arity}"
    dyn = MapSet.member?(@dyn, target) and
      (not MapSet.member?(@function_scoped_dyn, target) or env.function != nil)
    :ets.insert(:unused_events,
      {{kind, call_kind, to_string(env.file), line, column, ms(env.module), fnf(env.function), tomod, ns(name), arity, dyn}})
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
  def line_of(a) when is_integer(a) and a >= 0, do: a
  def line_of(a) when is_list(a) do
    if Keyword.keyword?(a) do
      case Keyword.get(a, :line, 0) do
        line when is_integer(line) and line >= 0 -> line
        _ -> 0
      end
    else
      0
    end
  end
  def line_of({l, _c}) when is_integer(l) and l >= 0, do: l
  def line_of(_), do: 0

  # Generated / reflection helpers a module always exposes — never claimable.
  def generated?(name, arity) do
    s = to_string(name)
    (s == "__mix_recompile__?" and arity == 0) or
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
                "behaviours" => behaviours,
                "protocol" => protocol,
                "impl" => impl,
                "partition" => partition})
        exports
        |> Enum.sort()
        |> Enum.each(fn {name, arity} ->
          unless generated?(name, arity) or String.starts_with?(to_string(name), "MACRO-") do
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
         behaviour_atoms <- List.flatten(behaviour_groups),
         true <- Enum.all?(behaviour_atoms, &is_atom/1),
         behaviours <- behaviour_atoms |> Enum.map(&inspect/1) |> Enum.uniq() |> Enum.sort(),
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
      {:docs_v1, anno, _, _, _, module_metadata, docs} when is_list(docs) ->
        flines =
          Enum.reduce(docs, %{}, fn
            {{:function, name, arity}, function_anno, _, _, metadata}, acc
                when is_atom(name) and is_integer(arity) and is_map(metadata) ->
              line = canonical_line(function_anno, metadata)
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
        {canonical_line(anno, module_metadata), flines}
      _ ->
        {0, %{}}
    end
  end

  defp canonical_line(fallback, metadata) when is_map(metadata) do
    case Map.get(metadata, :source_annos, []) do
      source_annos when is_list(source_annos) ->
        case source_annos |> Enum.map(&line_of/1) |> Enum.filter(&(&1 > 0)) do
          [] -> line_of(fallback)
          lines -> Enum.min(lines)
        end
      _ ->
        line_of(fallback)
    end
  end
  defp canonical_line(fallback, _metadata), do: line_of(fallback)

  defp valid_exports?(exports) do
    Enum.all?(exports, fn
      {name, arity} when is_atom(name) and is_integer(arity) and arity >= 0 -> true
      _ -> false
    end)
  end
end

defmodule Unused.Structure do
  @moduledoc false
  # The recursive visitor is stack-bounded at this fixed depth. Module discovery
  # and carrier extraction each visit a source node at most once, so the total
  # visit count remains a constant multiple of the parsed AST size.
  @max_source_bytes 8 * 1024 * 1024
  @max_ast_nodes 500_000
  @max_depth 256
  @max_carriers 20_000
  @max_facts 500_000
  @function_atom ~r/^[a-z_][A-Za-z0-9_]*[!?]?$/

  def dump(emit, root, partition, events) do
    owners =
      :ets.tab2list(:unused_owners)
      |> Enum.map(fn {owner} -> owner end)
      |> Enum.group_by(fn {_mod, file} -> file end, fn {mod, _file} -> mod end)

    started = System.monotonic_time(:microsecond)
    event_count = length(events)
    index_started = System.monotonic_time(:microsecond)
    event_index = index_events(events)
    event_index_us = System.monotonic_time(:microsecond) - index_started
    # event_index is now authoritative and the caller has no later use for
    # the canonical list. Reclaim its old-generation heap at this explicit
    # ownership-transfer boundary before parsing any source ASTs.
    :erlang.garbage_collect()
    summary = %{files: 0, complete_files: 0, incomplete_files: 0, bytes: 0,
      ast_nodes: 0, max_depth: 0, carriers: 0, facts: 0, exact_facts: 0,
      opaque_facts: 0, roles: %{}, file_extraction_us: 0, emit_us: 0}
    summary = owners
      |> Enum.sort_by(fn {file, _mods} -> file end)
      |> Enum.reduce(summary, fn {file, modules}, acc ->
        file_started = System.monotonic_time(:microsecond)
        record = file_record(root, partition, file, MapSet.new(modules), event_index)
        file_extraction_us = System.monotonic_time(:microsecond) - file_started
        emit_started = System.monotonic_time(:microsecond)
        emit.(record)
        emit_us = System.monotonic_time(:microsecond) - emit_started
        summarized = summarize(acc, record)
        %{summarized | file_extraction_us: summarized.file_extraction_us + file_extraction_us,
          emit_us: summarized.emit_us + emit_us}
      end)
    Map.merge(summary, %{k: "structure_summary", partition: partition,
      events: event_count,
      event_index_us: event_index_us,
      elapsed_us: System.monotonic_time(:microsecond) - started})
  end

  defp summarize(summary, record) do
    facts = Map.fetch!(record, "facts")
    roles = Enum.reduce(facts, summary.roles, fn fact, acc ->
      Map.update(acc, Map.fetch!(fact, "role"), 1, &(&1 + 1))
    end)
    exact = Enum.count(facts, &(Map.get(&1, "resolution") == "exact"))
    opaque = Enum.count(facts, &(Map.get(&1, "resolution") == "opaque"))
    complete = Map.fetch!(record, "status") == "complete"
    %{summary |
      files: summary.files + 1,
      complete_files: summary.complete_files + if(complete, do: 1, else: 0),
      incomplete_files: summary.incomplete_files + if(complete, do: 0, else: 1),
      bytes: summary.bytes + Map.fetch!(record, "bytes"),
      ast_nodes: summary.ast_nodes + Map.fetch!(record, "ast_nodes"),
      max_depth: max(summary.max_depth, Map.fetch!(record, "max_depth")),
      carriers: summary.carriers + length(Map.fetch!(record, "carriers")),
      facts: summary.facts + length(facts),
      exact_facts: summary.exact_facts + exact,
      opaque_facts: summary.opaque_facts + opaque,
      roles: roles}
  end

  defp file_record(root, partition, file, modules, event_index) do
    rel = Path.relative_to(Path.expand(file), Path.expand(root))
    base = %{"k" => "structure_file", "file" => rel, "partition" => partition}

    with :ok <- ensure(safe_relative?(rel), :ownership),
         expanded <- Path.expand(file),
         :ok <- ensure(within?(expanded, root), :ownership),
         {:ok, stat} <- File.lstat(expanded),
         :ok <- ensure(stat.type == :regular, :read),
         :ok <- ensure(stat.size <= @max_source_bytes, :size),
         {:ok, source} <- read_source_bounded(expanded, stat),
         digest <- :crypto.hash(:sha256, source) |> Base.encode16(case: :lower),
         {:ok, ast} <- Code.string_to_quoted(source,
           file: file,
           columns: true,
           token_metadata: true,
           existing_atoms_only: true,
           emit_warnings: false),
         {:ok, built} <- build(ast, file, modules, event_index) do
      Map.merge(base, %{
        "digest" => digest,
        "bytes" => byte_size(source),
        "status" => "complete",
        "reason" => :null,
        "ast_nodes" => built.nodes,
        "max_depth" => built.max_depth,
        "carriers" => Enum.reverse(built.carriers),
        "facts" => Enum.reverse(built.facts)
      })
    else
      {:error, :size} -> incomplete(base, "size")
      {:error, :limit} -> incomplete(base, "limit")
      {:error, :ownership} -> incomplete(base, "ownership")
      {:error, :read} -> incomplete(base, "read")
      {:error, %SyntaxError{}} -> incomplete(base, "parse")
      {:error, {_meta, _message, _token}} -> incomplete(base, "parse")
      {:error, _} -> incomplete(base, "read")
      _ -> incomplete(base, "read")
    end
  rescue
    _ -> incomplete(structure_base(root, partition, file), "parse")
  catch
    :throw, :structure_limit -> incomplete(structure_base(root, partition, file), "limit")
  end

  defp structure_base(root, partition, file),
    do: %{"k" => "structure_file", "file" => Path.relative_to(Path.expand(file), Path.expand(root)),
          "partition" => partition}

  defp incomplete(base, reason) do
    Map.merge(base, %{
      "digest" => String.duplicate("0", 64),
      "bytes" => 0,
      "status" => "incomplete",
      "reason" => reason,
      "ast_nodes" => 0,
      "max_depth" => 0,
      "carriers" => [],
      "facts" => []
    })
  end

  defp safe_relative?(rel) do
    rel != "." and rel != ".." and not String.starts_with?(rel, "../") and
      not String.starts_with?(rel, "/")
  end

  defp ensure(true, _reason), do: :ok
  defp ensure(false, reason), do: {:error, reason}

  defp read_source_bounded(path, before) do
    case :file.open(String.to_charlist(path), [:read, :binary, :raw]) do
      {:ok, descriptor} ->
        try do
          with {:ok, info} <- :file.read_file_info(descriptor),
               :ok <- validate_opened_source(path, before, info) do
            read_source_chunks(descriptor, [], 0)
          else
            {:error, :size} -> {:error, :size}
            _ -> {:error, :read}
          end
        after
          :file.close(descriptor)
        end
      _ -> {:error, :read}
    end
  end

  defp validate_opened_source(path, before, info) do
    with true <- is_tuple(info) and tuple_size(info) == 14 and elem(info, 0) == :file_info,
         true <- elem(info, 2) == :regular,
         :ok <- ensure(elem(info, 1) <= @max_source_bytes, :size),
         {:ok, after_open} <- File.lstat(path),
         true <- after_open.type == :regular,
         true <- same_file?(before, after_open),
         true <- descriptor_matches?(info, after_open) do
      :ok
    else
      {:error, :size} -> {:error, :size}
      _ -> {:error, :read}
    end
  end

  defp same_file?(left, right) do
    left.major_device == right.major_device and left.minor_device == right.minor_device and
      left.inode == right.inode
  end

  defp descriptor_matches?(info, stat) do
    elem(info, 9) == stat.major_device and elem(info, 10) == stat.minor_device and
      elem(info, 11) == stat.inode
  end

  defp read_source_chunks(descriptor, chunks, total) do
    requested = min(64 * 1024, @max_source_bytes - total + 1)
    case :file.read(descriptor, requested) do
      {:ok, chunk} ->
        next = total + byte_size(chunk)
        if next > @max_source_bytes,
          do: {:error, :size},
          else: read_source_chunks(descriptor, [chunk | chunks], next)
      :eof -> {:ok, chunks |> Enum.reverse() |> IO.iodata_to_binary()}
      _ -> {:error, :read}
    end
  end

  defp within?(path, root) do
    rel = Path.relative_to(Path.expand(path), Path.expand(root))
    safe_relative?(rel)
  end

  defp build(ast, file, modules, event_index) do
    state = %{nodes: 0, max_depth: 0, carriers: [], facts: [], next_carrier: 0,
              carrier_count: 0, fact_count: 0, unsupported: MapSet.new()}
    state = visit_modules(ast, file, modules, event_index, state, 1, nil)
    {:ok, state}
  catch
    :throw, :structure_limit -> {:error, :limit}
  end

  defp index_events(events) do
    Enum.reduce(events, %{carriers: MapSet.new(), by_target: MapSet.new(), by_call: %{}}, fn
      event = {_id, {_kind, _call_kind, file, line, column, from_mod, from_fun,
                             to_mod, name, arity, _dyn}}, acc ->
        carrier_key = {file, from_mod, from_fun}
        carriers = MapSet.put(acc.carriers, carrier_key)
        by_target = if is_binary(name) and is_integer(arity),
          do: MapSet.put(acc.by_target, {file, to_mod, "#{name}/#{arity}"}), else: acc.by_target
        call_key = {file, line, column, from_mod, from_fun, name, arity}
        {_id, {kind, call_kind, _file, _line, _column, _from_mod, _from_fun,
               _to_mod, _name, _arity, _dyn}} = event
        compact = {elem(event, 0), kind, call_kind, to_mod}
        by_call = Map.update(acc.by_call, call_key, [compact], &[compact | &1])
        %{acc | carriers: carriers, by_target: by_target, by_call: by_call}
    end)
  end

  defp visit_modules(node, file, modules, event_index, state, depth, lexical_mod) do
    state = tick(state, depth)
    case node do
      {:defmodule, _meta, [{:__aliases__, _alias_meta, parts}, body]}
          when is_list(parts) and is_list(body) ->
        mod = resolve_module(parts, lexical_mod, modules)
        state =
          if mod != nil do
            visit_definitions(Keyword.get(body, :do), mod, file, event_index, state, depth + 1)
          else
            state
          end
        visit_children(body, file, modules, event_index, state, depth + 1, mod || lexical_mod)
      {_, _, args} when is_list(args) ->
        visit_children(args, file, modules, event_index, state, depth + 1, lexical_mod)
      values when is_list(values) ->
        visit_children(values, file, modules, event_index, state, depth + 1, lexical_mod)
      _ -> state
    end
  end

  defp visit_children(values, file, modules, event_index, state, depth, lexical_mod) do
    Enum.reduce(values, state, fn value, acc ->
      child = if match?({_key, _value}, value), do: elem(value, 1), else: value
      visit_modules(child, file, modules, event_index, acc, depth, lexical_mod)
    end)
  end

  # The compiler's on-module inventory is authoritative. Source spelling only
  # selects among exact compiler-owned identities: a one-segment nested module
  # is lexical, qualified names remain lexical, and Elixir.X explicitly escapes
  # the lexical namespace.
  defp resolve_module([Elixir | rest], _lexical_mod, modules) when rest != [] do
    candidate = rest |> Module.concat() |> inspect()
    if MapSet.member?(modules, candidate), do: candidate, else: nil
  end
  defp resolve_module([part], lexical_mod, modules) when is_atom(part) do
    candidate = if lexical_mod == nil, do: inspect(Module.concat([part])),
      else: lexical_mod <> "." <> to_string(part)
    if MapSet.member?(modules, candidate), do: candidate, else: nil
  end
  defp resolve_module(parts, lexical_mod, modules) do
    suffix = parts |> Module.concat() |> inspect()
    candidate = if lexical_mod == nil, do: suffix, else: lexical_mod <> "." <> suffix
    if MapSet.member?(modules, candidate), do: candidate, else: nil
  end

  defp visit_definitions(nil, _mod, _file, _event_index, state, _depth), do: state
  defp visit_definitions({:__block__, _meta, values}, mod, file, event_index, state, depth) do
    Enum.reduce(values, state, &visit_definition(&1, mod, file, event_index, &2, depth))
  end
  defp visit_definitions(value, mod, file, event_index, state, depth) do
    visit_definition(value, mod, file, event_index, state, depth)
  end

  defp visit_definition({kind, meta, [head, body]}, mod, file, event_index, state, depth)
       when kind in [:def, :defp, :defmacro, :defmacrop] and is_list(body) do
    case definition_identity(head) do
      {name, arity}
      when kind in [:def, :defp] or (kind == :defmacro and name == :__using__ and arity == 1) ->
        fun = "#{name}/#{arity}"
        compiler_known = MapSet.member?(event_index.carriers, {file, mod, fun}) or
          (kind == :def) or MapSet.member?(event_index.by_target, {file, mod, fun})
        span = definition_span(meta, body)
        if not compiler_known or span == nil do
          state
        else
          id = state.next_carrier
          carrier = %{"id" => id, "mod" => mod, "fun" => fun,
                      "def_line" => Keyword.get(meta, :line, 0), "body" => span}
          state = %{state | next_carrier: id + 1, carrier_count: state.carrier_count + 1,
                           carriers: [carrier | state.carriers]}
          if state.carrier_count > @max_carriers, do: throw(:structure_limit)
          carrier = %{id: id, mod: mod, fun: fun, file: file, span: span,
                      event_index: event_index, using_selector: using_selector(head)}
          visit_function_body(body, carrier, state, depth + 1)
        end
      _ -> state
    end
  end
  defp visit_definition(_value, _mod, _file, _event_index, state, _depth), do: state

  defp definition_identity({:when, _meta, [head | guards]}) when guards != [],
    do: definition_identity(head)
  defp definition_identity({name, _meta, args})
       when is_atom(name) and (is_list(args) or is_nil(args)), do: {name, length(args || [])}
  defp definition_identity(_head), do: nil

  defp using_selector({:when, _meta, [head | _guards]}), do: using_selector(head)
  defp using_selector({:__using__, _meta, [{selector, _selector_meta, context}]})
       when is_atom(selector) and (is_atom(context) or is_nil(context)), do: selector
  defp using_selector(_head), do: nil

  defp visit_function_body(body, carrier, state, depth) do
    facts_before = state.facts
    fact_count_before = state.fact_count
    success = Keyword.get(body, :do)
    rescue_clauses = Keyword.get(body, :rescue, [])
    unsupported_control = Keyword.has_key?(body, :else) or Keyword.has_key?(body, :catch)
    if unsupported_control do
      %{state | unsupported: MapSet.put(state.unsupported, carrier.id)}
    else
      state = if rescue_clauses == [] do
        add_terminal_fact(state, carrier, "carrier-result", last_expression(success), nil)
      else
        state
        |> add_terminal_fact(carrier, "rescue-success", last_expression(success), carrier.span)
        |> add_clause_facts(carrier, "rescue-result", rescue_clauses, carrier.span)
      end
      state = walk(success, carrier, state, depth)
      state = Enum.reduce(rescue_clauses, state, fn clause, acc -> walk(clause, carrier, acc, depth) end)
      if MapSet.member?(state.unsupported, carrier.id),
        do: %{state | facts: facts_before, fact_count: fact_count_before}, else: state
    end
  end

  defp walk(nil, _carrier, state, _depth), do: state
  defp walk(node, carrier, state, depth) do
    state = tick(state, depth)
    state = add_runtime_reference_fact(state, carrier, node)
    case node do
      {:|>, meta, [left, right]} ->
        walk_pipeline(meta, left, right, carrier, state, depth)
      {name, meta, [condition, branches]} when name in [:if, :unless] and is_list(branches) ->
        state = if canonical_macro?(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
                     meta, name, 2), do: add_keyword_branch_facts(state, carrier, branches, node), else: state
        state = walk(condition, carrier, state, depth + 1)
        walk(branches, carrier, state, depth + 1)
      {:case, _meta, [subject, branches]} when is_list(branches) ->
        state = add_clause_facts(state, carrier, "branch-result", Keyword.get(branches, :do, []), node_span(node))
        state = walk(subject, carrier, state, depth + 1)
        walk(branches, carrier, state, depth + 1)
      {:with, _meta, values} when is_list(values) ->
        keywords = List.last(values)
        state = if Keyword.keyword?(keywords), do: add_keyword_branch_facts(state, carrier, keywords, node), else: state
        Enum.reduce(values, state, fn value, acc -> walk(value, carrier, acc, depth + 1) end)
      {:cond, meta, [branches]} when is_list(branches) ->
        state = if canonical_macro?(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
                     meta, :cond, 1), do: add_clause_facts(state, carrier, "branch-result",
                       Keyword.get(branches, :do, []), node_span(node)), else: state
        walk(branches, carrier, state, depth + 1)
      {:try, _meta, [parts]} when is_list(parts) ->
        target = node_span(node)
        unsupported_control = Keyword.has_key?(parts, :else) or Keyword.has_key?(parts, :catch)
        if unsupported_control do
          %{state | unsupported: MapSet.put(state.unsupported, carrier.id)}
        else
          state = add_terminal_fact(state, carrier, "rescue-success",
            last_expression(Keyword.get(parts, :do)), target)
          state = add_clause_facts(state, carrier, "rescue-result",
            Keyword.get(parts, :rescue, []), target)
          Enum.reduce(parts, state, fn {_key, value}, acc -> walk(value, carrier, acc, depth + 1) end)
        end
      {{:., _dot_meta, [_receiver, name]}, meta, args} when is_atom(name) and is_list(args) ->
        walk_call(node, meta, name, length(args), args, carrier, state, depth, 0, node_span(node))
      {name, meta, args} when is_atom(name) and is_list(meta) and is_list(args) ->
        if Macro.special_form?(name, length(args)) do
          Enum.reduce(args, state, fn value, acc -> walk(value, carrier, acc, depth + 1) end)
        else
          walk_call(node, meta, name, length(args), args, carrier, state, depth, 0, node_span(node))
        end
      {_left, _meta, args} when is_list(args) ->
        Enum.reduce(args, state, fn value, acc -> walk(value, carrier, acc, depth + 1) end)
      values when is_list(values) ->
        Enum.reduce(values, state, fn value, acc ->
          child = if match?({_key, _value}, value), do: elem(value, 1), else: value
          walk(child, carrier, acc, depth + 1)
        end)
      tuple when is_tuple(tuple) and tuple_size(tuple) == 2 ->
        tuple
        |> Tuple.to_list()
        |> Enum.reduce(state, fn value, acc -> walk(value, carrier, acc, depth + 1) end)
      _ -> state
    end
  end

  defp add_runtime_reference_fact(state, carrier,
       {:{}, _meta, [{:__aliases__, alias_meta, parts}, function, _arguments]} = tuple)
       when is_list(alias_meta) and is_list(parts) and is_atom(function) do
    tuple_span = node_span(tuple)
    module_span = node_span({:__aliases__, alias_meta, parts})
    matches = matching_alias_events(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
      alias_meta)
    if Regex.match?(@function_atom, Atom.to_string(function)) and tuple_span != nil and
         module_span != nil and length(matches) == 1 do
      {event_id, _kind, _call_kind, _to_mod} = hd(matches)
      add_fact(state, carrier.id, "runtime-mfa", tuple_span, module_span, event_id, nil, "exact")
    else
      state
    end
  end
  defp add_runtime_reference_fact(state, carrier,
       {:apply, meta, [{:__MODULE__, _module_meta, nil},
                       {selector, _selector_meta, context}, []]} = call)
       when is_list(meta) and is_atom(selector) and (is_atom(context) or is_nil(context)) do
    target = node_span(call)
    matches = matching_call_events(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
      meta, :apply, 3)
    exact = Enum.filter(matches, fn {_id, kind, call_kind, to_mod} ->
      kind in ["remote", "imported", "local"] and call_kind != nil and
        to_mod in ["Kernel", ":erlang"]
    end)
    if carrier.fun == "__using__/1" and carrier.using_selector == selector and target != nil and
         length(exact) == 1 do
      {event_id, _kind, _call_kind, _to_mod} = hd(exact)
      add_fact(state, carrier.id, "use-dispatcher", target, target, event_id, 1, "exact")
    else
      state
    end
  end
  defp add_runtime_reference_fact(state, _carrier, _node), do: state

  defp walk_pipeline(meta, left, right, carrier, state, depth) do
    target = pipeline_span(left, right, meta)
    pipe_exact = canonical_macro?(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
      meta, :|>, 2)
    case call_parts(right) do
      {call_meta, name, args} ->
        call_target = node_span(right)
        matches = matching_call_events(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
          call_meta, name, length(args) + 1)
        event_id = if pipe_exact and length(matches) == 1, do: elem(hd(matches), 0), else: nil
        state = add_call_fact(state, carrier, "pipeline-argument", left, target, event_id, 0)
        state = Enum.with_index(args, 1) |> Enum.reduce(state, fn {arg, index}, acc ->
          add_call_fact(acc, carrier, "call-argument", arg, call_target, event_id, index)
        end)
        state = walk(left, carrier, state, depth + 1)
        Enum.reduce(args, state, fn arg, acc -> walk(arg, carrier, acc, depth + 1) end)
      nil ->
        state = walk(left, carrier, state, depth + 1)
        walk(right, carrier, state, depth + 1)
    end
  end

  defp walk_call(_node, meta, name, arity, args, carrier, state, depth, offset, target) do
    matches = matching_call_events(carrier.event_index, carrier.file, carrier.mod, carrier.fun,
      meta, name, arity + offset)
    event_id = if length(matches) == 1, do: elem(hd(matches), 0), else: nil
    state = Enum.with_index(args, offset) |> Enum.reduce(state, fn {arg, index}, acc ->
      add_call_fact(acc, carrier, "call-argument", arg, target, event_id, index)
    end)
    Enum.reduce(args, state, fn arg, acc -> walk(arg, carrier, acc, depth + 1) end)
  end

  defp call_parts({{:., _dot, [_receiver, name]}, meta, args}) when is_atom(name) and is_list(args),
    do: {meta, name, args}
  defp call_parts({name, meta, args}) when is_atom(name) and is_list(meta) and is_list(args),
    do: {meta, name, args}
  defp call_parts(_), do: nil

  defp add_keyword_branch_facts(state, carrier, keywords, target_node) do
    target = node_span(target_node)
    state = add_terminal_fact(state, carrier, "branch-result", last_expression(Keyword.get(keywords, :do)), target)
    else_value = Keyword.get(keywords, :else)
    if clause_list?(else_value), do: add_clause_facts(state, carrier, "branch-result", else_value, target),
      else: add_terminal_fact(state, carrier, "branch-result", last_expression(else_value), target)
  end

  defp add_clause_facts(state, carrier, role, clauses, target) when is_list(clauses) do
    Enum.reduce(clauses, state, fn
      {:->, _meta, [_patterns, body]}, acc -> add_terminal_fact(acc, carrier, role, last_expression(body), target)
      _other, acc -> acc
    end)
  end
  defp add_clause_facts(state, _carrier, _role, _clauses, _target), do: state

  defp add_terminal_fact(state, _carrier, _role, nil, _target), do: state
  defp add_terminal_fact(state, carrier, role, value, target) do
    case node_span(value) do
      nil -> state
      from -> add_fact(state, carrier.id, role, from, target, nil, nil, nil)
    end
  end

  defp add_call_fact(state, carrier, role, value, target, event_id, argument) do
    case {node_span(value), target} do
      {from, to} when from != nil and to != nil ->
        add_fact(state, carrier.id, role, from, to, event_id, argument,
          if(event_id == nil, do: "opaque", else: "exact"))
      _ -> state
    end
  end

  defp add_fact(state, carrier, role, from, to, event_id, argument, resolution) do
    fact = %{"carrier" => carrier, "role" => role, "from" => from,
             "to" => json_value(to), "event_id" => json_value(event_id),
             "argument" => json_value(argument), "resolution" => json_value(resolution)}
    next = %{state | facts: [fact | state.facts], fact_count: state.fact_count + 1}
    if next.fact_count > @max_facts, do: throw(:structure_limit)
    next
  end

  defp canonical_macro?(event_index, file, mod, fun, meta, name, arity) do
    matches = matching_call_events(event_index, file, mod, fun, meta, name, arity)
    length(matches) == 1 and case hd(matches) do
      {_id, _kind, "macro", "Kernel"} -> true
      _ -> false
    end
  end

  defp matching_call_events(event_index, file, mod, fun, meta, name, arity) do
    line = Keyword.get(meta, :line, 0)
    column = Keyword.get(meta, :column, 0)
    if column > 0,
      do: Map.get(event_index.by_call, {file, line, column, mod, fun, to_string(name), arity}, []),
      else: []
  end

  defp matching_alias_events(event_index, file, mod, fun, meta) do
    line = Keyword.get(meta, :line, 0)
    column = Keyword.get(meta, :column, 0)
    if column > 0,
      do: Map.get(event_index.by_call, {file, line, column, mod, fun, nil, nil}, [])
        |> Enum.filter(fn {_id, kind, call_kind, _to_mod} -> kind == "alias" and call_kind == nil end),
      else: []
  end

  defp clause_list?(value) when is_list(value), do: Enum.all?(value, &match?({:->, _, _}, &1))
  defp clause_list?(_), do: false

  defp last_expression({:__block__, _meta, values}) when is_list(values), do: List.last(values)
  defp last_expression(value), do: value

  defp definition_span(meta, body) do
    start = point(meta)
    ending = token_point(Keyword.get(meta, :end), 3) ||
      point(Keyword.get(meta, :end_of_expression)) ||
      node_end(last_expression(Keyword.get(body, :do)))
    span(start, ending)
  end

  defp pipeline_span(left, right, meta) do
    span(node_start(left) || point(meta), node_end(right) || token_point(meta, 2))
  end

  defp node_span(node), do: span(node_start(node), node_end(node))
  defp node_start({:__block__, _meta, values}) when is_list(values), do: node_start(List.first(values))
  defp node_start({:|>, meta, [left, _right]}), do: node_start(left) || point(meta)
  defp node_start({{:., _dot, [_receiver, _name]}, meta, _args}), do: point(meta)
  defp node_start({name, meta, _args}) when is_atom(name) and is_list(meta), do: point(meta)
  defp node_start(_), do: nil

  defp node_end({:__block__, _meta, values}) when is_list(values), do: node_end(List.last(values))
  defp node_end({:|>, meta, [_left, right]}), do: node_end(right) || token_point(meta, 2)
  defp node_end({:__aliases__, meta, parts}) when is_list(meta) and is_list(parts) do
    case {Keyword.get(meta, :last), List.last(parts)} do
      {last_meta, part} when is_list(last_meta) and is_atom(part) ->
        token_point(last_meta, String.length(Atom.to_string(part)))
      _ -> nil
    end
  end
  defp node_end({{:., _dot, [_receiver, name]}, meta, args}) when is_atom(name) and is_list(args),
    do: call_end(meta, name, args)
  defp node_end({name, meta, args}) when is_atom(name) and is_list(meta) and is_list(args),
    do: call_end(meta, name, args)
  defp node_end(_), do: nil

  defp call_end(meta, name, args) do
    if Keyword.has_key?(meta, :delimiter) do
      # Quoted literals carry only the opening delimiter: strings use the
      # internal :<<>> form and interpolated charlists use a generated
      # List.to_charlist/1 call. Neither is a source call with a same-line
      # function-name extent. Nested interpolation calls are still walked.
      nil
    else
      exact = token_point(Keyword.get(meta, :closing), 1) ||
        token_point(Keyword.get(meta, :end), 3) ||
        point(Keyword.get(meta, :end_of_expression))
      cond do
        exact != nil -> exact
        Macro.special_form?(name, length(args)) -> nil
        true -> node_end(List.last(args)) || token_point(meta, String.length(to_string(name)))
      end
    end
  end

  defp point(meta) when is_list(meta) do
    case {Keyword.get(meta, :line), Keyword.get(meta, :column)} do
      {line, column} when is_integer(line) and line > 0 and is_integer(column) and column > 0 -> {line, column}
      _ -> nil
    end
  end
  defp point(_), do: nil

  defp token_point(meta, width) when is_list(meta) do
    case point(meta) do
      {line, column} -> {line, column + width}
      nil -> nil
    end
  end
  defp token_point(_, _), do: nil

  defp span({sl, sc}, {el, ec}) when el > sl or (el == sl and ec > sc),
    do: %{"sl" => sl, "sc" => sc, "el" => el, "ec" => ec}
  defp span(_, _), do: nil

  defp tick(state, depth) do
    if depth > @max_depth or state.nodes >= @max_ast_nodes, do: throw(:structure_limit)
    %{state | nodes: state.nodes + 1, max_depth: max(state.max_depth, depth)}
  end

  defp json_value(nil), do: :null
  defp json_value(value), do: value
end

defmodule Unused.Output do
  @moduledoc false

  def take_events do
    # The ETS set already performs the exact-tuple deduplication previously
    # provided by Enum.uniq. Transfer it once, release the table before sort,
    # then assign stable IDs without two additional full intermediate lists.
    entries = :ets.tab2list(:unused_events)
    true = :ets.delete(:unused_events)
    {events, _next_id} = entries
      |> Enum.sort()
      |> Enum.map_reduce(0, fn {event}, id -> {{id, event}, id + 1} end)
    events
  end

  def dump_events(emit, root, partition, events) do
    Enum.each(events, fn {id, {kind, call_kind, file, line, column, from_mod, from_fun,
                               to_mod, name, arity, dyn}} ->
      base = %{"k" => "event", "id" => id, "kind" => kind,
               "call_kind" => if(call_kind == nil, do: :null, else: call_kind),
               "file" => Path.relative_to(file, root), "line" => line, "column" => column,
               "from_mod" => if(from_mod == nil, do: :null, else: from_mod),
               "to_mod" => to_mod, "dyn" => dyn,
               "partition" => partition}
      base = if from_fun, do: Map.put(base, "from_fun", from_fun), else: base
      base = if name, do: Map.put(base, "name", name), else: base
      base = if arity != nil, do: Map.put(base, "arity", arity), else: base
      emit.(base)
    end)
  end

  def dump_owners(emit, root, partition) do
    :ets.tab2list(:unused_owners)
    |> Enum.map(fn {owner} -> owner end)
    |> Enum.sort()
    |> Enum.each(fn {mod, file} ->
      emit.(%{"k" => "owner", "mod" => mod, "file" => Path.relative_to(file, root),
              "partition" => partition})
    end)
  end
end

defmodule Unused.RustlerIsolation do
  @moduledoc false

  def with_overrides(path, fun) when is_function(fun, 0) do
    identities =
      path
      |> File.read!()
      |> :json.decode()
      |> decode_identities()

    previous =
      Enum.map(identities, fn {app, module} ->
        value = Application.fetch_env(app, module)
        config = case value do {:ok, found} -> found; :error -> [] end
        unless Keyword.keyword?(config), do: raise("invalid Rustler application configuration")
        {app, module, value, Keyword.put(config, :skip_compilation?, true)}
      end)

    Enum.each(previous, fn {app, module, _value, config} ->
      Application.put_env(app, module, config, persistent: false)
    end)

    try do
      fun.()
    after
      Enum.each(previous, fn
        {app, module, {:ok, value}, _config} ->
          Application.put_env(app, module, value, persistent: false)
        {app, module, :error, _config} ->
          Application.delete_env(app, module, persistent: false)
      end)
    end
  end

  defp decode_identities(values) when is_list(values) do
    Enum.map(values, fn
      %{"module" => module, "otpApp" => app}
          when is_binary(module) and is_binary(app) ->
        unless Regex.match?(~r/^[A-Z][A-Za-z0-9_.]*$/, module) and
                 Regex.match?(~r/^[a-z][a-z0-9_]*$/, app) do
          raise "invalid Rustler loader identity"
        end
        {String.to_atom(app), Module.concat(String.split(module, "."))}
      _ ->
        raise "invalid Rustler loader inventory"
    end)
  end
  defp decode_identities(_), do: raise("invalid Rustler loader inventory")
end

# --- output sink -----------------------------------------------------------
out = System.get_env("UNUSED_OUT")
{:ok, io} = File.open(out, [:write, :utf8])
emit = fn map -> IO.puts(io, IO.iodata_to_binary(:json.encode(map))) end
root = File.cwd!()
phase = System.get_env("UNUSED_PHASE") || "production"
emit.(%{"k" => "phase", "protocol" => 2, "phase" => phase, "status" => "started"})

:ets.new(:unused_events, [:public, :named_table, :set, write_concurrency: true])
:ets.new(:unused_owners, [:public, :named_table, :set, write_concurrency: true])
Code.put_compiler_option(:tracers, [Unused.Tracer])

case phase do
  "production" ->
    compile_ok = Unused.RustlerIsolation.with_overrides(
      System.fetch_env!("UNUSED_RUSTLER_LOADERS"),
      fn ->
        case Mix.Task.rerun("compile.elixir", ["--force", "--return-errors"]) do
          {:error, diagnostics} when is_list(diagnostics) and diagnostics != [] ->
            emit.(%{"k" => "compile_error", "count" => length(diagnostics),
                    "details" => Enum.map(diagnostics, &inspect/1)})
            false
          _ -> true
        end
      end)

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
        events = Unused.Output.take_events()
        Unused.Output.dump_events(emit, root, "prod", events)
        Unused.Output.dump_owners(emit, root, "prod")
        structure_summary = Unused.Structure.dump(emit, root, "prod", events)
        emit.(structure_summary)
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
    emit.(%{"k" => "phase", "protocol" => 2, "phase" => "production",
            "status" => if(complete, do: "complete", else: "incomplete")})

  "test" ->
    inventory =
      System.fetch_env!("UNUSED_INVENTORY")
      |> File.read!()
      |> :json.decode()
    test_files = Map.fetch!(inventory, "testFiles") |> Enum.sort()

    {support_ok, _test_mods, tests_ok} = Unused.RustlerIsolation.with_overrides(
      System.fetch_env!("UNUSED_RUSTLER_LOADERS"),
      fn ->
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
        {support_ok, test_mods, tests_ok}
      end)

    compile_complete = support_ok and tests_ok
    reflection_ok =
      if compile_complete do
        Unused.Output.dump_owners(emit, root, "test")
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
      events = Unused.Output.take_events()
      Unused.Output.dump_events(emit, root, "test", events)
      emit.(Unused.Structure.dump(emit, root, "test", events))
    else
      emit.(%{"k" => "test_compile_error"})
    end
    emit.(%{"k" => "phase", "protocol" => 2, "phase" => "test",
            "status" => if(complete, do: "complete", else: "incomplete")})

  _ ->
    emit.(%{"k" => "phase", "protocol" => 2, "phase" => phase, "status" => "incomplete"})
end

File.close(io)
`;
