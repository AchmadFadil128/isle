// SPDX-License-Identifier: GPL-3.0-or-later

//! Keeps the Vulkan functions src/vulkan.rs defines private to the program: exported, they would
//! stand in for the loader's and drivers' own once those are loaded.

fn main() {
    if std::env::var_os("CARGO_FEATURE_VULKAN").is_none() {
        return;
    }
    let script =
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join("exports.map");
    std::fs::write(&script, "{ local: *; };\n").expect("writing the version script");
    println!(
        "cargo:rustc-link-arg-bins=-Wl,--version-script={}",
        script.display()
    );
    println!("cargo:rerun-if-changed=build.rs");
}
