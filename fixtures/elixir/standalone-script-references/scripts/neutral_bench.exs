alias NeutralScript.Target, as: Target
Target.zero()
NeutralScript.Target.one(:sample)
callback = {Target, :zero, []}
NeutralScript.Target.zero()
{NeutralScript.Target, :one, [:sample]}
callback
