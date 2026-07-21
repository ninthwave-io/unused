defmodule NeutralSupport.StandardCase do
  defmacro value do
    quote do
      NeutralSupport.Subject.reached_from_standard_support()
    end
  end
end
