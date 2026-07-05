fn main() {
    let mut users = vec![String::from("alice")];
    let first_user = &users[0];
    users.push(String::from("bob"));
    println!("{}", first_user);
}
