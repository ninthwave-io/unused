defmodule NeutralRole.SignatureOnly do
  defmacro __using__(which) do
    quote bind_quoted: [which: which], do: which
  end
end

defmodule NeutralRole.Misdirected do
  defmacro __using__(selector) do
    which = :controller
    _ = selector
    apply(__MODULE__, which, [])
  end

  def router, do: quote(do: :router)
  def controller, do: quote(do: :controller)
end
