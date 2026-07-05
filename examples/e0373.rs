fn main() {
    let name = String::from("alice");

    std::thread::spawn(|| {
        println!("{}", name);
    });
}
