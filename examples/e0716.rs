fn main() {
    let borrowed = String::from("temporary").as_str();
    println!("{}", borrowed);
}
