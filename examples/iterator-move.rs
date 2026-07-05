#[derive(Debug)]
struct User {
    name: String,
}

fn main() {
    let users = vec![User { name: String::from("alice") }];

    for user in users {
        println!("{}", user.name);
    }

    println!("{:?}", users);
}
