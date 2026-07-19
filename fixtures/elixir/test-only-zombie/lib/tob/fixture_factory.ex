defmodule Tob.FixtureFactory do
  @moduledoc "Referenced only from a test — a whole test-only file, deletable with its test."
  def build, do: %{id: 1}
end
