defmodule NeutralLedgerCallerUse.Web do
  defmacro __using__(:entry) do
    quote do
      @neutral_entry true
    end
  end

  defmacro __using__(:generated) do
    quote do
      def run(raw), do: NeutralLedgerCallerUse.Target.consume(String.to_atom(raw))
    end
  end

  defmacro __using__(:nested) do
    quote do
      def run(raw), do: generated_private(raw)
      defp generated_private(raw), do: NeutralLedgerCallerUse.Target.consume(String.to_atom(raw))
    end
  end
end
