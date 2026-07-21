defmodule NeutralMfa.Runtime do
  @moduledoc "A minimal neutral runtime that accepts public MFA callback data."

  def invoke({module, function, init}), do: apply(module, function, [:request | init])
end
