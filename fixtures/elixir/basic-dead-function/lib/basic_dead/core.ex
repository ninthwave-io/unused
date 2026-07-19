defmodule BasicDead.Core do
  @moduledoc "One public function is reached from the app callback; one is not."

  def greet(name), do: "Hello, #{name}"

  # Nothing references this — a clean dead public function.
  def unused_helper(x), do: x + 1
end
