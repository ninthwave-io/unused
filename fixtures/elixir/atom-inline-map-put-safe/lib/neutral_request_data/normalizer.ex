defmodule NeutralRequestData.Normalizer do
  def normalize(params) when is_map(params) do
    normalize_kind(Map.get(params, "kind"), params)
  end

  defp normalize_kind(value, params) do
    case value do
      raw_kind when is_binary(raw_kind) ->
        try do
          {:ok, Map.put(params, :kind, String.to_existing_atom(raw_kind))}
        rescue
          ArgumentError -> {:error, :unknown_kind}
        end

      _other ->
        {:error, :invalid_kind}
    end
  end

  def genuinely_unused, do: :unused
end
