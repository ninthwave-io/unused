defmodule NeutralAlias.Dispatch do
  def a, do: apply(ExternalAlias, :run, []); def b, do: NeutralAlias.Target
end

defmodule NeutralAlias.Target do
  def run, do: :ran
end

defmodule Direct do
  def run, do: :wrong
end

defmodule NeutralAlias.Other do
  def run, do: :right
end

defmodule NeutralAlias.ShadowDispatch do
  def execute do; alias NeutralAlias.Other, as: Direct; apply(Direct, :run, []) end
  def external_execute do; alias External.Library, as: Direct; apply(Direct, :run, []) end
end
