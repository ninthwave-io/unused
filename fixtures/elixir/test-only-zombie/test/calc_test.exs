defmodule Tob.CalcTest do
  use ExUnit.Case

  test "add/2 sums" do
    assert Tob.Calc.add(1, 2) == 3
  end
end
