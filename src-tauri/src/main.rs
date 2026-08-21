// Prevents an extra console window on Windows in release. DO NOT REMOVE:
// without it every launch of the installed app opens a black console behind
// the dashboard.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nwa_testing_software_lib::run()
}
