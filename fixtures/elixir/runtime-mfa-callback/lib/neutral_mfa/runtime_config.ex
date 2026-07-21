defmodule NeutralMfa.RuntimeConfig do
  @moduledoc "Models a framework configuration callback expressed as an MFA tuple."

  def callback, do: {NeutralMfa.Callback, :callback_name, []}
end
