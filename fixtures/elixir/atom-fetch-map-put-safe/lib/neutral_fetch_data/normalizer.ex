defmodule NeutralFetchData.Normalizer do
  def normalize(params) when is_map(params), do: normalize_params(params)

  defp normalize_params(params) do
    case Map.fetch(params, "kind") do
      {:ok, raw_kind} when is_binary(raw_kind) ->
        try do
          {:ok, Map.put(params, :kind, String.to_existing_atom(raw_kind))}
        rescue
          ArgumentError -> {:error, :unknown_kind}
        end

      :error ->
        {:error, :missing_kind}
    end
  end

  def genuinely_unused, do: :unused
end
