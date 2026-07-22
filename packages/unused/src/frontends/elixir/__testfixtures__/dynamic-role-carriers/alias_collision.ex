defmodule NeutralAlias.Dispatch do
  def a, do: apply(ExternalAlias, :run, []); def b, do: NeutralAlias.Target
end

defmodule NeutralAlias.Target do
  def run, do: :ran
end
