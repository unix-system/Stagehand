//! The message server exercised by a fake plugin over raw HTTP (no Studio needed).
use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

#[path = "../src/server.rs"]
mod server;

use server::{Message, MessageReceiver, OutputLevel, RobloxMessage};

fn http(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    let mut resp = String::new();
    s.read_to_string(&mut resp).unwrap();
    let status: u16 = resp.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = resp.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

#[test]
fn full_session_over_http() {
    let rx = MessageReceiver::start(0, "sid-123".into()).unwrap();
    let port = rx.port();
    assert_ne!(port, 0);

    assert_eq!(http(port, "GET", "/", ""), (200, "sid-123".to_string()));
    assert_eq!(http(port, "POST", "/start", "").0, 200);
    assert_eq!(http(port, "POST", "/messages", r#"[{"type":"Output","level":"Warning","body":"careful"}]"#).0, 200);
    assert_eq!(http(port, "POST", "/messages", "{nope").0, 400);
    assert_eq!(http(port, "GET", "/nope", "").0, 404);
    assert_eq!(http(port, "POST", "/stop", "").0, 200);

    assert_eq!(rx.recv_timeout(Duration::from_secs(1)), Some(Message::Start));
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(1)),
        Some(Message::Messages(vec![RobloxMessage::Output { level: OutputLevel::Warning, body: "careful".into() }]))
    );
    assert_eq!(rx.recv_timeout(Duration::from_secs(1)), Some(Message::Stop));
    assert_eq!(rx.recv_timeout(Duration::from_millis(100)), None);
    rx.stop(); // must not hang
}

#[test]
fn port_in_use_is_an_error() {
    let a = MessageReceiver::start(0, "a".into()).unwrap();
    assert!(MessageReceiver::start(a.port(), "b".into()).is_err());
    a.stop();
}
