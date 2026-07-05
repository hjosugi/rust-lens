fn main() {
    let name = String::from("alice");
    let borrowed = &name;
    let moved = name;
    println!("{}", borrowed);
    println!("{}", moved);
}
