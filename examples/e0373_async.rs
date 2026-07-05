use std::future::Future;

fn spawn<F>(_future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
}

async fn run() {
    let name = String::from("alice");

    spawn(async {
        println!("{}", name);
    });
}

fn main() {}
