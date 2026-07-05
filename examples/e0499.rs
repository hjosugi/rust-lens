fn main() {
    let mut count = 0;
    let first = &mut count;
    let second = &mut count;
    *first += 1;
    *second += 1;
}
