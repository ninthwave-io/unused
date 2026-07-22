defmodule NeutralAtomFlow.Dispatch do
  def immediate(name), do: String.to_atom(name).run()

  def assigned(name) do
    receiver = String.to_existing_atom(name)
    receiver.run()
  end

  def mixed(values, key) do
    {Map.fetch!(values, String.to_existing_atom(key)), String.to_atom(key).run()}
  end

  def tuple_only(key, value), do: {String.to_atom(key), value}

  def mfa_pipeline(data) do
    data
    |> Enum.map(fn {key, value} -> {String.to_atom(key), :run, [value]} end)
    |> Enum.into(%{})
  end

  def intervening_pipeline(data) do
    data
    |> Enum.map(fn {key, value} -> {String.to_atom(key), value} end)
    |> Enum.reverse()
    |> Enum.into(%{})
  end

  def sequenced_pipeline(data) do
    data
    |> Enum.map(fn {key, value} ->
      {String.to_atom(key), value}; {key, value}
    end)
    |> Enum.into(%{})
  end

  def nested_pipeline(data) do
    data
    |> Enum.map(fn item ->
      (fn {key, value} -> {String.to_atom(key), value} end).(item)
    end)
    |> Enum.into(%{})
  end
end
