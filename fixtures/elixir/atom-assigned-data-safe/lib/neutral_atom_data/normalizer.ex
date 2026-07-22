defmodule NeutralAtomData.Normalizer do
  def normalize(entries, raw_kind) when is_list(entries) and is_binary(raw_kind) do
    normalize_entries(entries, raw_kind)
  end

  defp normalize_entries(entries, raw_kind) when is_binary(raw_kind) do
    kind = String.to_existing_atom(raw_kind)

    Enum.map(entries, fn entry ->
      %{entry: entry, kind: kind}
    end)
  rescue
    ArgumentError -> []
  end

  def genuinely_unused, do: :unused
end
