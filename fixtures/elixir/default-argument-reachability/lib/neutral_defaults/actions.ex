defmodule NeutralDefaults.Actions do
  def from_short(value, mode \\ :neutral), do: NeutralDefaults.Worker.perform(value, mode)

  def direct(value, mode \\ :neutral), do: {value, mode}

  def ranged(value, mode \\ :neutral, options \\ [])
  def ranged(value, :neutral, options), do: {value, options}
  def ranged(value, mode, options), do: {value, mode, options}
end
