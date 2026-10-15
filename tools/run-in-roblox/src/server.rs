//! The localhost HTTP server the injected plugin talks to. Same wire protocol as upstream
//! run-in-roblox 0.3.0 so the plugin template is interchangeable.

use std::{
    io::Read,
    sync::{mpsc, Arc},
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{anyhow, Context};
use serde::Deserialize;
use tiny_http::{Method, Response, Server};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Start,
    Stop,
    Messages(Vec<RobloxMessage>),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type")]
pub enum RobloxMessage {
    Output { level: OutputLevel, body: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum OutputLevel {
    Print,
    Info,
    Warning,
    Error,
}

impl OutputLevel {
    pub fn tag(self) -> &'static str {
        match self {
            OutputLevel::Print => "",
            OutputLevel::Info => "[info] ",
            OutputLevel::Warning => "[warn] ",
            OutputLevel::Error => "[error] ",
        }
    }
}

pub fn parse_messages(body: &str) -> serde_json::Result<Vec<RobloxMessage>> {
    serde_json::from_str(body)
}

pub struct MessageReceiver {
    server: Arc<Server>,
    rx: mpsc::Receiver<Message>,
    thread: Option<JoinHandle<()>>,
    port: u16,
}

impl MessageReceiver {
    /// Bind `127.0.0.1:port` (0 picks a free port) and start serving on a background thread.
    pub fn start(port: u16, server_id: String) -> anyhow::Result<Self> {
        let server = Server::http(("127.0.0.1", port))
            .map_err(|e| anyhow!("{e}"))
            .with_context(|| format!("could not bind 127.0.0.1:{port} (is another run-in-roblox running?)"))?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or_else(|| anyhow!("server has no TCP address"))?
            .port();
        let server = Arc::new(server);
        let (tx, rx) = mpsc::channel();
        let worker = Arc::clone(&server);
        let thread = thread::spawn(move || {
            for mut request in worker.incoming_requests() {
                let path = request.url().split('?').next().unwrap_or("").to_string();
                let response = match (request.method(), path.as_str()) {
                    (Method::Get, "/") => Response::from_string(server_id.clone()),
                    (Method::Get, "/health") => Response::from_string("ok"),
                    (Method::Post, "/start") => {
                        let _ = tx.send(Message::Start);
                        Response::from_string("Started")
                    }
                    (Method::Post, "/stop") => {
                        let _ = tx.send(Message::Stop);
                        Response::from_string("Finished")
                    }
                    (Method::Post, "/messages") => {
                        let mut body = String::new();
                        if request.as_reader().read_to_string(&mut body).is_err() {
                            Response::from_string("unreadable body").with_status_code(400)
                        } else {
                            match parse_messages(&body) {
                                Ok(messages) => {
                                    let _ = tx.send(Message::Messages(messages));
                                    Response::from_string("Got it!")
                                }
                                Err(e) => Response::from_string(format!("bad json: {e}")).with_status_code(400),
                            }
                        }
                    }
                    _ => Response::from_string("not found").with_status_code(404),
                };
                let _ = request.respond(response);
            }
        });
        Ok(Self { server, rx, thread: Some(thread), port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn recv_timeout(&self, d: Duration) -> Option<Message> {
        self.rx.recv_timeout(d).ok()
    }

    /// Stop accepting requests and join the worker thread.
    pub fn stop(mut self) {
        self.server.unblock();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_output_messages() {
        let m = parse_messages(r#"[{"type":"Output","level":"Error","body":"x"},{"type":"Output","level":"Print","body":"y"}]"#).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0], RobloxMessage::Output { level: OutputLevel::Error, body: "x".into() });
        assert_eq!(m[1], RobloxMessage::Output { level: OutputLevel::Print, body: "y".into() });
    }

    #[test]
    fn rejects_unknown_level_or_type() {
        assert!(parse_messages(r#"[{"type":"Output","level":"Loud","body":"x"}]"#).is_err());
        assert!(parse_messages(r#"[{"type":"Nope","level":"Print","body":"x"}]"#).is_err());
        assert!(parse_messages("not json").is_err());
    }
}
