defmodule NeutralAtomKey.Lookup do
  def fetch(values, key) do
    Map.fetch!(
      values,
      String.to_existing_atom(key)
    )
  end

  def masked(values, key) do
    _example = "String.to_atom(key).run() # inert"
    _charlist = 'String.to_existing_atom(key).run()'
    _heredoc = """
    String.to_atom(key).run()
    """
    _sigil = ~S"String.to_existing_atom(key).run()"
    # String.to_existing_atom(key).run()
    Map.get(values, String.to_existing_atom(key))
  end

  def predicate(values, key) do
    Map.has_key?(values, String.to_existing_atom(key))
  end

  def rebuild(data) do
    data
    |> Enum.map(fn
      {key, value} when is_binary(key) ->
        {String.to_atom(key), String.upcase(value)}

      {key, value} ->
        {key, value}
    end)
    |> Enum.into(%{})
  end

  def genuinely_unused, do: :unused
end
