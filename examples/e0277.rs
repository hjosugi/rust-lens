fn print_debug<T>(value: T) {
    println!("{:?}", value);
}

fn main() {
    print_debug(String::from("needs Debug"));
}
