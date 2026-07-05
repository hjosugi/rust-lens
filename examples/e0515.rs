fn get_ref() -> &str {
    let s = String::from("hello");
    &s
}

fn main() {
    println!("{}", get_ref());
}
