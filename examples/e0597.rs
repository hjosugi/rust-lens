fn main() {
    let borrowed;

    {
        let value = String::from("short lived");
        borrowed = &value;
    }

    println!("{}", borrowed);
}
