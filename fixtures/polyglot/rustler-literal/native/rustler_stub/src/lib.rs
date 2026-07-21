extern crate proc_macro;

use proc_macro::TokenStream;

#[proc_macro_attribute]
pub fn nif(_attributes: TokenStream, item: TokenStream) -> TokenStream {
    item
}

#[proc_macro]
pub fn init(_input: TokenStream) -> TokenStream {
    TokenStream::new()
}
