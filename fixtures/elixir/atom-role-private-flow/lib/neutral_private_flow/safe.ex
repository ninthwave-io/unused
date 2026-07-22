defmodule NeutralPrivateFlow.Safe do
  @moduledoc false

  alias String, as: NeutralString
  import Map, only: [has_key?: 2]
  require Integer

  @neutral_options [modes: [:lookup, :fallback], enabled: true, nested: %{limit: 2}]
  @neutral_words ~w(alpha beta)a
  @neutral_words_raw ~W(alpha beta)a
  @neutral_string ~s(literal string)
  @neutral_string_raw ~S(literal string)
  @neutral_date ~D[2026-07-22]
  @neutral_time ~T[12:34:56]
  @neutral_naive ~N[2026-07-22 12:34:56]
  @neutral_utc ~U[2026-07-22 12:34:56Z]

  @spec lookup?(map(), String.t()) :: boolean()
  def lookup?(map, raw), do: contains?(map, build_key(raw))

  def genuinely_unused, do: :unused

  defp build_key(raw), do: String.to_existing_atom(raw)
  defp contains?(map, key), do: has_key?(map, key)
end
