defmodule NeutralPublicFlow.Safe do
  @moduledoc false

  def direct?(map, raw), do: consume?(map, String.to_existing_atom(raw))

  def passed?(map, raw), do: Map.has_key?(map, identity(String.to_existing_atom(raw)))

  def genuinely_unused, do: :unused

  def consume?(map, key), do: Map.has_key?(map, key)
  def identity(value), do: value
end
