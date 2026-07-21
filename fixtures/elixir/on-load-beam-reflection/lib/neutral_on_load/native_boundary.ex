defmodule NeutralOnLoad.NativeBoundary do
  @behaviour NeutralOnLoad.Callback
  @on_load :__load_native__

  defstruct [:value]

  def __load_native__ do
    File.write!(Path.join(File.cwd!(), ".neutral-on-load-ran"), "executed\n")
    :native_library_unavailable
  end

  @impl true
  def perform, do: :ok

  def reachable, do: :reachable
  def unused_sibling, do: :unused
  def with_default(value \\ :default), do: value

  defmacro compile_helper, do: quote(do: :compiled)
end
