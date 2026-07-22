defmodule NeutralGenerated.Controller do
  use NeutralGenerated.Web, :controller; def action(selected, args), do: apply(runtime_module(), selected, args)
end
