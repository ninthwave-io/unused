defmodule NeutralDeadInbound.DeadCaller do
  @first NeutralDeadInbound.FirstTarget.value()
  @second NeutralDeadInbound.SecondTarget.value()

  def values, do: {@first, @second}
end
