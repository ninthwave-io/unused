defmodule NeutralAtomFlow.Dispatch do
  def immediate(name), do: String.to_atom(name).run()

  def assigned(name) do
    receiver = String.to_existing_atom(name)
    receiver.run()
  end

  def mixed(values, key) do
    {Map.fetch!(values, String.to_existing_atom(key)), String.to_atom(key).run()}
  end
end
