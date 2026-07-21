defmodule NeutralPartition.SubjectTest do
  use ExUnit.Case, async: true

  @runtime_marker Application.fetch_env!(:neutral_partition, :runtime_marker)

  test "uses the public subject after the application starts" do
    assert @runtime_marker == :started
    assert NeutralPartition.Subject.checked_only_in_test() == :present
  end
end
