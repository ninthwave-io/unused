defmodule NeutralLedgerUse.Web do
  defmacro __using__(:controller) do
    quote do
      @neutral_controller true
    end
  end
end
