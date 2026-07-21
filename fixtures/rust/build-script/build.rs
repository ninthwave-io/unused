fn main() {
    println!("cargo::rerun-if-changed=build.rs");
}

fn dead_build_helper() {}

