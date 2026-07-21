#[rustler::nif]
fn live_nif(left: i64, right: i64) -> i64 {
    left + right
}

#[rustler::nif]
fn dead_nif(value: i64) -> i64 {
    value
}

rustler::init!("Elixir.NeutralBridge.Native");
