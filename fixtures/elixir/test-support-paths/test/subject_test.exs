defmodule NeutralSupport.SubjectTest do
  use ExUnit.Case, async: true
  require NeutralSupport.StandardCase

  test "both effective support paths are compiled" do
    assert NeutralSupport.StandardCase.value() == :standard
    assert NeutralSupport.CustomCase.value() == :custom
  end
end
