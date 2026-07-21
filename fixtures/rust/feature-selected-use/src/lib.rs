fn feature_helper() -> usize {
    1
}

#[cfg(feature = "extra")]
pub fn feature_entry() -> usize {
    feature_helper()
}

pub fn public_api() -> usize {
    2
}

