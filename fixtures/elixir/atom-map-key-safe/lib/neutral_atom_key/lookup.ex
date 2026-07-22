defmodule NeutralAtomKey.Lookup do
  def fetch(values, key) do
    Map.fetch!(
      values,
      String.to_existing_atom(key)
    )
  end

  def masked(values, key) do
    _example = "String.to_atom(key).run() # inert"
    # String.to_existing_atom(key).run()
    Map.get(values, String.to_existing_atom(key))
  end

  def genuinely_unused, do: :unused
end
