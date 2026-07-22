defmodule NeutralGenerated.Application do
  def start(_type, _args), do: NeutralGenerated.Controller.kind()
end
