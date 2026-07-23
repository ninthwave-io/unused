defmodule NeutralCrossFlow.Flow do
  alias NeutralCrossFlow.Consumer, as: NeutralConsumer

  def direct?(map, raw), do: NeutralConsumer.consume?(map, String.to_atom(raw))

  def pass?(map, raw), do: Map.has_key?(map, NeutralConsumer.identity(String.to_atom(raw)))

  def imported?(map, raw), do: NeutralCrossFlow.Importer.via_import?(map, String.to_atom(raw))

  def wrapped?(map, raw), do: local_wrapper(map, String.to_atom(raw))
  def local_wrapper(map, key), do: NeutralCrossFlow.Consumer.consume?(map, key)

  def genuinely_unused, do: :unused
end
