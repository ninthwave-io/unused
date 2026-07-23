defmodule NeutralCrossFlow.Importer do
  import NeutralCrossFlow.Consumer, only: [consume?: 2]

  def via_import?(map, key), do: consume?(map, key)
end
